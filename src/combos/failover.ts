import { parseResetCooldownMs } from "../codex/routing";
import { classifyError, isCyberPolicyCode } from "../lib/errors";
import { parseRetryAfterMs as parseRetryAfterMsBounded } from "../lib/http-retry-after";
import type { OcxComboTarget } from "../types";
import { targetKey } from "./types";
import {
  captureConfigGeneration,
  sweepExpiredOnWrite,
  type GenerationContext,
} from "../lib/state-store-sweeper";

interface TargetCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
/** Short cooldown for request-rate 429s (for example provider code 1302) that omit Retry-After. */
export const COMBO_REQUEST_RATE_COOLDOWN_MS = 5_000;

const QUOTA_LIMIT_CODES = new Set([
  "1308",
  "1310",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "insufficient_quota",
]);
const TRANSIENT_REQUEST_RATE_CODES = new Set(["1302", "1305"]);

/** Map<`${comboId}\0${provider/model}`, TargetCooldown> */
const targetCooldowns = new Map<string, TargetCooldown>();
let lastReconciledGeneration = 0;
let liveComboTargets = new Set<string>();

function cooldownMapKey(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
): string {
  return `${comboId}\0${targetKey(target)}`;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
  options?: { preserveImmediate?: boolean },
): number | undefined {
  return parseRetryAfterMsBounded(value, now, { ...options, maxMs: MAX_COOLDOWN_MS });
}

export function isComboTargetInCooldown(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): boolean {
  const key = cooldownMapKey(comboId, target);
  const entry = targetCooldowns.get(key);
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    targetCooldowns.delete(key);
    return false;
  }
  return true;
}

export function isTransientRequestRateLimit(input: {
  status?: number;
  code?: string | null;
  message?: string;
}): boolean {
  if (isProviderScopedQuotaCap(input.status, input.message ?? "", input.code)) return false;
  const code = (input.code ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (QUOTA_LIMIT_CODES.has(code)) return false;
  if (TRANSIENT_REQUEST_RATE_CODES.has(code)) return true;
  const text = (input.message ?? "").toLowerCase();
  if (
    text.includes("usage limit reached")
    || text.includes("insufficient_quota")
    || text.includes("quota exhausted")
  ) {
    return false;
  }
  return text.includes("rate limit reached for requests");
}

export function remainingComboCooldownMs(comboId: string, now = Date.now()): number | undefined {
  const prefix = `${comboId}\0`;
  let soonest: number | undefined;
  for (const [key, cooldown] of targetCooldowns) {
    if (!key.startsWith(prefix)) continue;
    const remaining = cooldown.cooldownUntil - now;
    if (remaining <= 0) {
      targetCooldowns.delete(key);
      continue;
    }
    if (soonest === undefined || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

export function comboCooldownRetryAfterSeconds(comboId: string, now = Date.now()): string | undefined {
  const remainingMs = remainingComboCooldownMs(comboId, now);
  if (remainingMs === undefined) return undefined;
  return String(Math.max(1, Math.ceil(remainingMs / 1000)));
}

export function coolComboTarget(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  options?: {
    retryAfter?: string | null;
    resetAt?: unknown | unknown[];
    now?: number;
    cooldownMs?: number;
    writerGeneration?: number;
    status?: number;
    code?: string | null;
    message?: string;
  },
): void {
  const now = options?.now ?? Date.now();
  const writerGeneration = options?.writerGeneration ?? captureConfigGeneration();
  const ownerKey = `${comboId}::${targetKey(target)}`;
  if (writerGeneration < lastReconciledGeneration && !liveComboTargets.has(ownerKey)) return;
  // A server-provided Retry-After is authoritative, including an immediate `0` directive.
  // A quota reset is the next-most-specific signal (#3256); configured and default cooldowns
  // are only fallbacks when upstream supplied neither usable value.
  const cooldownMs = parseRetryAfterMs(options?.retryAfter, now, { preserveImmediate: true })
    ?? parseResetCooldownMs(options?.resetAt, now)
    ?? options?.cooldownMs
    ?? (isTransientRequestRateLimit({
      status: options?.status,
      code: options?.code,
      message: options?.message,
    }) ? COMBO_REQUEST_RATE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
  targetCooldowns.set(cooldownMapKey(comboId, target), {
    cooldownUntil: now + Math.min(Math.max(cooldownMs, 1), MAX_COOLDOWN_MS),
  });
  sweepExpiredOnWrite(now);
}

export function earliestComboCooldown(
  comboId: string,
  targets: Iterable<Pick<OcxComboTarget, "provider" | "model">>,
  now = Date.now(),
): { expiry: number; target: Pick<OcxComboTarget, "provider" | "model"> } | undefined {
  let earliest: { expiry: number; target: Pick<OcxComboTarget, "provider" | "model"> } | undefined;
  for (const target of targets) {
    const key = cooldownMapKey(comboId, target);
    const entry = targetCooldowns.get(key);
    if (!entry || entry.cooldownUntil <= now) continue;
    if (earliest === undefined || entry.cooldownUntil < earliest.expiry) {
      earliest = { expiry: entry.cooldownUntil, target };
    }
  }
  return earliest;
}

/** Public convenience wrapper returning only the earliest cooldown expiry. */
export function earliestComboCooldownExpiry(
  comboId: string,
  targets: Iterable<Pick<OcxComboTarget, "provider" | "model">>,
  now = Date.now(),
): number | undefined {
  return earliestComboCooldown(comboId, targets, now)?.expiry;
}

export function reconcileComboTargetCooldowns(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  liveComboTargets = new Set(context.comboTargets);
  lastReconciledGeneration = context.generation;
  return 0;
}

export function sweepExpiredComboTargetCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of targetCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    targetCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}

export function clearComboTargetCooldowns(comboId?: string): void {
  if (comboId === undefined) {
    targetCooldowns.clear();
    liveComboTargets.clear();
    lastReconciledGeneration = 0;
    return;
  }
  const prefix = `${comboId}\0`;
  for (const key of targetCooldowns.keys()) {
    if (key.startsWith(prefix)) targetCooldowns.delete(key);
  }
}

export type ComboFailureDecision = "hop" | "stop";
export type ComboFailureCooldownScope = "none" | "target" | "provider";

function normalizedFailureCode(code?: string | null): string {
  return code?.trim().toLowerCase().replaceAll("-", "_") ?? "";
}

function isProviderScopedQuotaCap(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  const normalizedCode = normalizedFailureCode(code);
  const text = message.toLowerCase();
  if (
    status === 429
    && (normalizedCode === "gousagelimiterror" || text.includes("monthly usage limit reached"))
  ) {
    return true;
  }
  return text.includes("err_free_prompt_cap")
    || (text.includes("free tier") && text.includes("single request"));
}

/**
 * A free-tier cap the upstream evaluates PER REQUEST rather than per account window. These
 * needles used to reach only `isProviderScopedQuotaCap`, so a single oversized free-tier prompt
 * cooled the whole provider for every other combo — including the shorter requests that same
 * provider would still have served. `free_rate_limited` also left the provider-scoped predicate
 * for the same reason; it stays a hop signal, but stops recording provider-wide evidence.
 */
function isRequestLocalFreePromptCap(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 400) return false;
  const text = message.toLowerCase();
  if (normalizedFailureCode(code) === "free_rate_limited") return true;
  if (text.includes("err_free_prompt_cap")) return true;
  return text.includes("free tier") && (text.includes("single request") || text.includes("prompt"));
}

/**
 * Failures that describe the SHAPE of this request rather than the health of the target.
 * Cooling anything for these is wrong twice over: the target is fine, and the next request
 * (shorter prompt, smaller tool catalog) would have succeeded against it.
 */
const REQUEST_SHAPE_FAILURE_CODES = new Set([
  "input_admission_refused",
  "context_length_exceeded",
  "tool_catalog_too_large",
  "cursor_root_envelope_limit",
  "target_incompatible",
]);

/** Credential/billing failures that every target sharing the provider inherits. */
const PROVIDER_SCOPED_FAILURE_CODES = new Set([
  "invalid_api_key",
  "insufficient_quota",
  "subscription_required",
  "payment_required",
  "billing_error",
  "insufficient_balance",
]);

export function comboFailureCooldownScope(
  status: number,
  message: string,
  options?: { code?: string | null },
): ComboFailureCooldownScope {
  const code = normalizedFailureCode(options?.code);
  // Request-shape refusals first: an oversized request must not cool a healthy target.
  if (
    status === 413
    || REQUEST_SHAPE_FAILURE_CODES.has(code)
    || isRequestLocalFreePromptCap(status, message, options?.code)
    || isProviderTargetContextOverflow(status, message, options?.code)
  ) return "none";
  if (isProviderScopedQuotaCap(status, message, options?.code)) return "provider";
  // A rejected or unpaid credential is provider-wide evidence: every target that routes
  // through the same provider row carries the same key and will fail identically.
  if (status === 401 || status === 402 || status === 403) return "provider";
  if (PROVIDER_SCOPED_FAILURE_CODES.has(code)) return "provider";
  return "target";
}

function isModelLifecycleGone(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 410) return false;
  const normalizedCode = code?.trim().toLowerCase().replaceAll("-", "_");
  if ([
    "model_deprecated",
    "model_end_of_life",
    "model_eol",
    "model_not_found",
    "model_retired",
  ].includes(normalizedCode ?? "")) return true;
  const text = message.toLowerCase();
  return /\bmodel\b/.test(text) && (
    /\bend[ -]of[ -]life\b/.test(text)
    || /\bno longer available\b/.test(text)
    || /\b(?:deprecated|retired|retirement|sunset|decommissioned)\b/.test(text)
  );
}

function isProviderTargetContextOverflow(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 400) return false;
  const normalizedCode = normalizedFailureCode(code);
  const text = message.toLowerCase();
  if (text.includes("invalid_request_prompt_too_long")) return true;
  return normalizedCode === "5059"
    && /\bprompt\s+\d+\s*>\s*\d+\s+maximum context length\b/i.test(message);
}

export function comboFailureDecision(
  status: number,
  message: string,
  options?: { code?: string | null },
): ComboFailureDecision {
  if (status === 499) return "stop";
  if (message.toLowerCase().includes("origin_rejected")) return "stop";
  // Cyber policy is a hard non-retryable refusal — honor structured code even when
  // classificationText was truncated before the JSON code field.
  if (isCyberPolicyCode(options?.code)) return "stop";
  // HTTP 410 is normally terminal. A model-specific lifecycle verdict is target-local,
  // however: another provider/model in the declared combo can still serve the request.
  // Require structured lifecycle code or explicit model+lifecycle prose so unrelated
  // application-level 410 responses remain fail-closed.
  if (isModelLifecycleGone(status, message, options?.code)) return "hop";
  const error = classifyError(status, "upstream_error", message);
  if (isCyberPolicyCode(error.code)) return "stop";
  // A provider can expose its own target hard cap with a non-semantic vendor code
  // (for example 5059 + invalid_request_prompt_too_long). That is evidence that this
  // target is too small, not that every later combo target is incapable of serving it.
  if (isProviderTargetContextOverflow(status, message, options?.code)) return "hop";
  // A local input-admission refusal (#1524) says "this candidate cannot fit the request",
  // not "the request is impossible": the next candidate may have a larger context window.
  //
  // This MUST be tested before the generic stop list below. Our own refusal message says
  // "context window" -- that is what it refuses on -- and the classifier remaps that phrase,
  // so checking the stop list first swallowed the signal and ended the chain. An UPSTREAM
  // `context_length_exceeded` carries no admission code and still falls through to stop.
  //
  // Matched on the STRUCTURED code only, which classifyError now preserves for our own
  // refusal. A raw substring test would additionally let any upstream override a terminal
  // verdict by echoing the token in prose we do not control.
  //
  // Precise about what this is NOT: an upstream can still SET this code deliberately, since
  // both extractors read the upstream error object. That is bounded rather than dangerous --
  // an upstream already controls other hop signals (429, 5xx), and traversal is finite: policy
  // tries each candidate once via `tried`, and combo excludes each attempted target. So this is
  // structured-code-only, not provably local.
  if (options?.code === "input_admission_refused" || error.code === "input_admission_refused") {
    return "hop";
  }
  if (isProviderScopedQuotaCap(status, message, options?.code || error.code)) {
    return "hop";
  }
  // A model-scoped rejection is target-local: this provider does not serve THIS model, which
  // says nothing about the next combo target. Structured code only, plus the explicit prose
  // form upstreams emit when they carry no code, so an unrelated 400 stays terminal.
  const failureCode = normalizedFailureCode(options?.code || error.code);
  if (["model_not_found", "model_unavailable", "unsupported_model"].includes(failureCode)) {
    return "hop";
  }
  // `free_rate_limited` no longer routes through `isProviderScopedQuotaCap` (it is a
  // per-request cap, not provider-wide evidence), so keep its hop verdict explicit here.
  if (failureCode === "free_rate_limited") return "hop";
  if (["origin_rejected", "context_length_exceeded", "invalid_request_error"].includes(error.code ?? "")) {
    return "stop";
  }
  // 402 (payment required) and 425 (too early) are provider-state signals, not verdicts about
  // the request: another combo target can still serve it.
  if ([401, 402, 403, 404, 408, 425, 429].includes(status) || status >= 500) return "hop";
  if ([
    "permission_denied",
    "subscription_required",
    "invalid_api_key",
    "insufficient_quota",
    "payment_required",
    "billing_error",
    "insufficient_balance",
    "rate_limit_exceeded",
    "server_is_overloaded",
    "upstream_server_error",
  ].includes(error.code ?? "")) {
    return "hop";
  }
  return "stop";
}
