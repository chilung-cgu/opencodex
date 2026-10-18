import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../../../src/adapters/google";
import {
  __resetVertexApiKeyProjectCache,
  parseVertexProbeProjectNumber,
  resolveVertexApiKeyProject,
} from "../../../src/adapters/google-vertex-key-project";
import { vertexReplayModelKey } from "../../../src/adapters/google-vertex-endpoint";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";

const PROBE = "https://aiplatform.googleapis.com/v1/publishers/google/models/ocx-project-probe:countTokens";
const notFound = (project: string) => JSON.stringify({
  error: {
    code: 404,
    message: `Publisher model \`projects/${project}/locations/asia-southeast1/publishers/google/models/ocx-project-probe\` was not found or your project does not have access to it.`,
    status: "NOT_FOUND",
  },
});

const realFetch = globalThis.fetch;
let probes: Array<{ url: string; key: string | null; redirect?: RequestRedirect }> = [];
let projectByKey: Record<string, string> = {};
let probeStatus = 404;

beforeEach(() => {
  __resetVertexApiKeyProjectCache();
  probes = [];
  probeStatus = 404;
  projectByKey = { "key-a": "111111111111", "key-b": "222222222222" };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const key = new Headers(init?.headers).get("x-goog-api-key");
    probes.push({ url, key, redirect: init?.redirect });
    if (url !== PROBE) return new Response("unexpected", { status: 500 });
    const project = key ? projectByKey[key] : undefined;
    return new Response(project && probeStatus === 404 ? notFound(project) : "denied", { status: probeStatus });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetVertexApiKeyProjectCache();
});

function parsed(modelId = "gemini-4-argon"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: { messages: [{ role: "user", content: "hi" }], systemPrompt: [], tools: [] },
    options: {},
  } as unknown as OcxParsedRequest;
}

const vertex = (apiKey: string, extra: Partial<OcxProviderConfig> = {}) => ({
  adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", apiKey, project: "auto", ...extra,
}) as OcxProviderConfig;

describe("vertex project auto", () => {
  test("parses the project number from Google's projectless NOT_FOUND body", () => {
    expect(parseVertexProbeProjectNumber(notFound("22932377871"))).toBe("22932377871");
    expect(parseVertexProbeProjectNumber("projects/my-project/locations/global")).toBeUndefined();
    expect(parseVertexProbeProjectNumber("no project here")).toBeUndefined();
  });

  test("each key in a pool reaches its own project on the global endpoint", async () => {
    const a = await createGoogleAdapter(vertex("key-a")).buildRequest(parsed());
    const b = await createGoogleAdapter(vertex("key-b")).buildRequest(parsed());
    expect(a.url).toBe("https://aiplatform.googleapis.com/v1/projects/111111111111/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(b.url).toBe("https://aiplatform.googleapis.com/v1/projects/222222222222/locations/global/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(a.headers["x-goog-api-key"]).toBe("key-a");
    expect(b.headers["x-goog-api-key"]).toBe("key-b");
    // The probe only ever goes to the fixed Google authority, with the key it resolves, no redirects.
    expect(probes).toEqual([
      { url: PROBE, key: "key-a", redirect: "manual" },
      { url: PROBE, key: "key-b", redirect: "manual" },
    ]);
  });

  test("honors an explicit regional location", async () => {
    const req = await createGoogleAdapter(vertex("key-a", { location: "us" })).buildRequest({ ...parsed(), stream: false } as OcxParsedRequest);
    expect(req.url).toBe("https://us-aiplatform.googleapis.com/v1/projects/111111111111/locations/us/publishers/google/models/gemini-4-argon:generateContent");
  });

  test("probes once per key, including concurrent first requests", async () => {
    await Promise.all([resolveVertexApiKeyProject("key-a"), resolveVertexApiKeyProject("key-a")]);
    await resolveVertexApiKeyProject("key-a");
    expect(probes.length).toBe(1);
  });

  for (const status of [401, 403, 429, 503]) {
    test(`a ${status} probe sends that request to express without caching`, async () => {
      probeStatus = status;
      const fallback = await createGoogleAdapter(vertex("key-a")).buildRequest(parsed());
      expect(fallback.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
      expect(fallback.headers["x-goog-api-key"]).toBe("key-a");
      probeStatus = 404;
      const req = await createGoogleAdapter(vertex("key-a")).buildRequest(parsed());
      expect(req.url).toContain("/projects/111111111111/locations/global/");
      expect(probes.length).toBe(2);
    });
  }

  test("a network failure during the probe also falls back to express", async () => {
    globalThis.fetch = (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    const req = await createGoogleAdapter(vertex("key-a")).buildRequest(parsed());
    expect(req.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
  });

  test("a key rotated into the same provider resolves the new key's project", async () => {
    const provider = vertex("key-a");
    const first = await createGoogleAdapter(provider).buildRequest(parsed());
    // Key-pool failover hands the adapter a provider whose apiKey is the next pool entry.
    const rotated = await createGoogleAdapter({ ...provider, apiKey: "key-b" }).buildRequest(parsed());
    expect(first.url).toContain("/projects/111111111111/");
    expect(rotated.url).toContain("/projects/222222222222/");
    expect(rotated.headers["x-goog-api-key"]).toBe("key-b");
  });

  test("resolved projects get per-project replay namespaces", () => {
    expect(vertexReplayModelKey({ kind: "project", project: "111111111111", location: "global" }, "gemini-4-argon"))
      .not.toBe(vertexReplayModelKey({ kind: "project", project: "222222222222", location: "global" }, "gemini-4-argon"));
    expect(vertexReplayModelKey({ kind: "project", project: "111111111111", location: "global" }, "gemini-4-argon"))
      .toBe("vertex:project:111111111111:global:gemini-4-argon");
  });

  test("an explicit project and a projectless key never probe", async () => {
    const explicit = await createGoogleAdapter(vertex("key-a", { project: "fixture-project" })).buildRequest(parsed());
    expect(explicit.url).toContain("/projects/fixture-project/locations/global/");
    const express = await createGoogleAdapter(vertex("key-a", { project: undefined })).buildRequest(parsed());
    expect(express.url).toBe("https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-4-argon:streamGenerateContent?alt=sse");
    expect(probes).toEqual([]);
  });

  test("accepts case-insensitive AUTO and honors a provider-scoped fetch", async () => {
    let customCalls = 0;
    const customFetch = (async () => {
      customCalls++;
      return new Response(notFound("333333333333"), { status: 404 });
    }) as unknown as typeof fetch;
    const req = await createGoogleAdapter({
      ...vertex("key-c", { project: "  Auto " }),
      fetch: customFetch,
    } as OcxProviderConfig).buildRequest(parsed());
    expect(req.url).toContain("/projects/333333333333/locations/global/");
    expect(customCalls).toBe(1);
    expect(probes).toEqual([]);
  });

  test("ADC rejects auto instead of treating it as a project id", async () => {
    const adc = { adapter: "google", baseUrl: "https://aiplatform.googleapis.com", googleMode: "vertex", project: "auto", location: "global" } as OcxProviderConfig;
    const prevKey = process.env.GOOGLE_CLOUD_API_KEY;
    delete process.env.GOOGLE_CLOUD_API_KEY;
    try {
      await expect(createGoogleAdapter(adc).buildRequest(parsed())).rejects.toThrow(/requires an API key/);
    } finally {
      if (prevKey !== undefined) process.env.GOOGLE_CLOUD_API_KEY = prevKey;
    }
    expect(probes).toEqual([]);
  });
});
