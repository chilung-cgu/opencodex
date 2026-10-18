import { accountAutoPauseFenceMatchesDisk, type AccountAutoPauseFence } from "../config/account-auto-pause-revisions";
import { randomUUID } from "node:crypto";
import { OAuthAccountPausedError } from "../oauth";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { ProviderApiKeySelection } from "../types/provider";
import type { AccountPauseDetails } from "../types/account-auto-pause";
import { apiKeyPoolEntryId } from "./api-keys";
import { resolveProviderApiKey } from "./api-key-resolve";
import { commitProviderApiKeySelection } from "./api-key-selection";

export class ProviderApiKeyPausedError extends OAuthAccountPausedError {
  constructor() {
    super("API key is paused. Resume it in account settings and retry.");
    this.name = "ProviderApiKeyPausedError";
  }
}

export function isProviderApiKeyPaused(provider: OcxProviderConfig | undefined): boolean {
  if (!provider || provider.authMode === "oauth" || provider.authMode === "forward" || provider.authMode === "local") {
    return false;
  }
  const pool = provider.apiKeyPool;
  if (!pool?.length) return false;
  if (pool.every(entry => entry.disabled === true)) return true;
  const ref = provider._apiKeyAttempt?.reference ?? provider.apiKey;
  if (!ref?.trim()) return false;
  return pool.some(entry => entry.disabled === true && entry.key === ref)
    && !pool.some(entry => !entry.disabled && entry.key === ref);
}

export function setProviderApiKeyPaused(config: OcxConfig, name: string, id: string, paused: boolean,
  automatic?: { fence: AccountAutoPauseFence; selection: ProviderApiKeySelection; pauseRevision?: string; resolvedKey?: string; details: AccountPauseDetails }): boolean {
  const result = commitProviderApiKeySelection(config, name, provider => {
    if (automatic && !accountAutoPauseFenceMatchesDisk(name, automatic.fence)) return { changed: false, value: false };
    const pool = provider.apiKeyPool?.length ? provider.apiKeyPool
      : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
    const entry = pool.find(e => e.id === id);
    if (!entry || automatic && (entry.disabled || entry.key !== automatic.selection.reference || entry.pauseRevision !== automatic.pauseRevision
      || provider.accountAutoPause?.enabled !== true || resolveProviderApiKey(entry.key) !== automatic.resolvedKey)) return { changed: false, value: false };
    provider.apiKeyPool = pool;
    const idx = pool.indexOf(entry);
    const ordered = idx >= 0 ? [...pool.slice(idx + 1), ...pool.slice(0, idx)] : pool;
    const activeDisabled = () => !provider.apiKey
      || (pool.some(e => e.disabled && e.key === provider.apiKey) && !pool.some(e => !e.disabled && e.key === provider.apiKey));
    if (!automatic && Boolean(entry.disabled) === paused) {
      if (paused && provider.apiKey === entry.key) {
        const next = ordered.find(e => !e.disabled);
        if (next) provider.apiKey = next.key;
        else delete provider.apiKey;
        return { changed: true, selectionChanged: true, value: true };
      }
      if (!paused && activeDisabled()) {
        provider.apiKey = entry.key;
        return { changed: true, selectionChanged: true, value: true };
      }
      return { changed: false, value: true };
    }
    entry.disabled = paused;
    entry.pauseRevision = randomUUID();
    if (automatic) entry.pauseDetails = automatic.details;
    else delete entry.pauseDetails;
    if (paused && provider.apiKey === entry.key) {
      const next = ordered.find(e => !e.disabled);
      if (next) provider.apiKey = next.key;
      else delete provider.apiKey;
    } else if (!paused && activeDisabled()) provider.apiKey = entry.key;
    return { changed: true, selectionChanged: true, value: true };
  }, automatic?.selection);
  return result.status === "committed" && result.value;
}
