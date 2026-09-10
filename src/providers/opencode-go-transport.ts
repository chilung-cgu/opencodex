import { createHash, randomUUID } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { registryEntryForProviderDestination } from "./registry";

export const OPENCODE_GO_SESSION_HEADER = "x-opencode-session";

function hasHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers ?? {}).some(key => key.toLowerCase() === target);
}

/** Derive a provider-scoped opaque value without exposing Codex task or subagent ids. */
export function deriveOpenCodeGoSessionId(sessionLane: string): string {
  const digest = createHash("sha256")
    .update("opencodex/opencode-go/session/v1\0")
    .update(sessionLane)
    .digest("hex")
    .slice(0, 32);
  return `ocx_${digest}`;
}

/**
 * Add per-conversation Go affinity only to the canonical fixed-key destination.
 *
 * When an explicit or WeakMap-allocated session lane is provided, it is hashed into
 * a stable session id. If an unlinked caller passes undefined, randomUUID() serves
 * as a standalone fallback to satisfy Console Go header requirements without asserting
 * cross-request stability.
 */
export function resolveOpenCodeGoTransport<T extends OcxProviderConfig>(
  provider: T,
  sessionLane: string | undefined,
): T {
  if (registryEntryForProviderDestination(provider)?.id !== "opencode-go") return provider;
  const effectiveLane = sessionLane || randomUUID();
  if (hasHeaderCaseInsensitive(provider.headers, OPENCODE_GO_SESSION_HEADER)) return provider;

  return {
    ...provider,
    headers: {
      ...(provider.headers ?? {}),
      [OPENCODE_GO_SESSION_HEADER]: deriveOpenCodeGoSessionId(effectiveLane),
    },
  };
}
