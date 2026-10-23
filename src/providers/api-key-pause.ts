import { accountAutoPauseFenceMatchesDisk, type AccountAutoPauseFence } from "../config/account-auto-pause-revisions";
import { randomUUID } from "node:crypto";
import { clearModelCache } from "../codex/model-cache";
import type { OcxConfig } from "../types";
import type { ProviderApiKeySelection } from "../types/provider";
import type { AccountPauseDetails } from "../types/account-auto-pause";
import { ProviderApiKeyPausedError, isProviderApiKeyPaused } from "./api-key-pause-state";
import { apiKeyPoolEntryId } from "./api-keys";
import { clearKeyCooldowns } from "./api-key-cooldowns";
import { resolveProviderApiKey } from "./api-key-resolve";
import { commitProviderApiKeySelection } from "./api-key-selection";
import { forgetApiKeyRotationCursor } from "./key-failover";
import { clearProviderQuotaCacheFor } from "./quota/report-cache";

export { ProviderApiKeyPausedError, isProviderApiKeyPaused } from "./api-key-pause-state";

export function setProviderApiKeyPaused(config: OcxConfig, name: string, id: string, paused: boolean,
  automatic?: { fence: AccountAutoPauseFence; selection: ProviderApiKeySelection; pauseRevision?: string; resolvedKey?: string; details: AccountPauseDetails }): boolean {
  let activeKeyChanged = false;
  const result = commitProviderApiKeySelection(config, name, provider => {
    if (automatic && !accountAutoPauseFenceMatchesDisk(name, automatic.fence)) return { changed: false, value: false };
    const pool = provider.apiKeyPool?.length ? provider.apiKeyPool
      : provider.apiKey ? [{ id: apiKeyPoolEntryId(provider.apiKey), key: provider.apiKey }] : [];
    const entry = pool.find(e => e.id === id);
    if (!entry || automatic && (entry.disabled || entry.key !== automatic.selection.reference || entry.pauseRevision !== automatic.pauseRevision
      || provider.accountAutoPause?.enabled !== true || resolveProviderApiKey(entry.key) !== automatic.resolvedKey)) return { changed: false, value: false };
    const beforeApiKey = provider.apiKey;
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
        activeKeyChanged = beforeApiKey !== provider.apiKey;
        return { changed: true, selectionChanged: true, value: true };
      }
      if (!paused && activeDisabled()) {
        provider.apiKey = entry.key;
        activeKeyChanged = beforeApiKey !== provider.apiKey;
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
    activeKeyChanged = beforeApiKey !== provider.apiKey;
    return { changed: true, selectionChanged: true, value: true };
  }, automatic?.selection);
  const ok = result.status === "committed" && result.value;
  if (ok && !automatic) {
    clearKeyCooldowns(name);
    forgetApiKeyRotationCursor(name);
    if (activeKeyChanged) {
      clearModelCache(name);
      clearProviderQuotaCacheFor(name);
    }
  }
  return ok;
}
