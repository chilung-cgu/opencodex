import { createHash } from "node:crypto";

/**
 * Per-key project discovery for Vertex express-mode API keys (`provider.project: "auto"`).
 *
 * An express-mode key belongs to exactly one Google Cloud project, but the key itself does not
 * carry the id. Google's projectless endpoint names the key's project in its NOT_FOUND message
 * (`projects/<number>/locations/<region>/...`), so one countTokens call for a model id that
 * cannot exist resolves it without credentials beyond the key and without inference billing.
 * The result is the project NUMBER, which the project endpoint accepts in place of the id.
 *
 * This lets an apiKeyPool hold keys from different projects: each request resolves the project
 * of the key it actually sends. Only the fixed Google authority ever receives the key.
 */
export const VERTEX_PROJECT_AUTO = "auto";

const PROBE_URL = "https://aiplatform.googleapis.com/v1/publishers/google/models/ocx-project-probe:countTokens";
const PROBE_TIMEOUT_MS = 10_000;
const PROJECT_NUMBER = /\bprojects\/(\d{1,20})\/locations\//;
/** Pool sizes are small; the cap only bounds a pathological rotation of distinct keys. */
const CACHE_LIMIT = 64;

/** Keyed by a digest so the cache never retains raw key material. Insertion-order LRU. */
const resolved = new Map<string, string>();
const inflight = new Map<string, Promise<string | undefined>>();

function cacheKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("base64url");
}

function remember(key: string, project: string): void {
  resolved.delete(key);
  resolved.set(key, project);
  while (resolved.size > CACHE_LIMIT) resolved.delete(resolved.keys().next().value!);
}

/** Extracts the project number from Google's projectless NOT_FOUND body; exported for tests. */
export function parseVertexProbeProjectNumber(body: string): string | undefined {
  return PROJECT_NUMBER.exec(body)?.[1];
}

async function probe(apiKey: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const res = await fetchImpl(PROBE_URL, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "x" }] }] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Only Google's model NOT_FOUND names the key's project; 401/403/429 and redirects do not.
    if (res.status !== 404) return undefined;
    return parseVertexProbeProjectNumber(await res.text());
  } catch {
    return undefined;
  }
}

/**
 * Resolves the project number that owns `apiKey`, or undefined when Google does not reveal it.
 * Successful lookups are cached per key; failures are not, so a transient error retries next time.
 * The caller sends that request to the express endpoint instead, so Google's own status for the
 * key (401/403/429) reaches the normal key-pool failover rather than a synthetic probe error.
 */
export async function resolveVertexApiKeyProject(apiKey: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string | undefined> {
  const key = cacheKey(apiKey);
  const cached = resolved.get(key);
  if (cached) {
    remember(key, cached);
    return cached;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = probe(apiKey, fetchImpl).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const project = await pending;
  if (project) remember(key, project);
  return project;
}

export function __resetVertexApiKeyProjectCache(): void {
  resolved.clear();
  inflight.clear();
}
