import { afterEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter } from "../src/adapters/google";
import type { OcxParsedRequest } from "../src/types";
import { scanEventsForWebSearch } from "../src/web-search/loop";
import { runWebSearch } from "../src/web-search/executor";

const provider = { adapter: "google", baseUrl: "https://generativelanguage.googleapis.com", apiKey: "key" };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function parsedWith(messages: unknown[]): OcxParsedRequest {
  return { modelId: "gemini-3.7-flash", stream: false, options: {}, context: { messages, tools: [] } } as unknown as OcxParsedRequest;
}

describe("web-search loop — thought signature capture", () => {
  test("scanEventsForWebSearch preserves the tool_call_start thoughtSignature", () => {
    const { calls } = scanEventsForWebSearch([
      { type: "tool_call_start", id: "call_abc", name: "web_search", thoughtSignature: "EpMBCpABARFNMg9hsKzS" },
      { type: "tool_call_delta", arguments: "{\"query\":\"hello\"}" },
      { type: "tool_call_end" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.id).toBe("call_abc");
    expect(calls[0]!.thoughtSignature).toBe("EpMBCpABARFNMg9hsKzS");
  });

  test("scanEventsForWebSearch leaves thoughtSignature undefined when absent", () => {
    const { calls } = scanEventsForWebSearch([
      { type: "tool_call_start", id: "call_abc", name: "web_search" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.thoughtSignature).toBeUndefined();
  });
});

describe("google adapter — thought signature forwarding", () => {
  test("assistant toolCall with a real signature is forwarded as functionCall.thoughtSignature", async () => {
    const parsed = parsedWith([
      { role: "user", content: "hi", timestamp: 0 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "web_search", arguments: { query: "x" }, thoughtSignature: "EpMBCpABARFNMg9hsKzSDcdjcfnegypDQKWEcIl0" },
        ],
        timestamp: 0,
      },
    ]);
    const { body } = await createGoogleAdapter(provider).buildRequest(parsed);
    const wire = JSON.parse(body) as { contents: { role: string; parts: Record<string, unknown>[] }[] };
    const modelPart = wire.contents.find(c => c.role === "model")!.parts[0]!;
    expect((modelPart.functionCall as { name: string }).name).toBe("web_search");
    expect(modelPart.thoughtSignature).toBe("EpMBCpABARFNMg9hsKzSDcdjcfnegypDQKWEcIl0");
  });

  test("synthetic tool-call ids are never forwarded as thoughtSignature", async () => {
    const parsed = parsedWith([
      { role: "user", content: "hi", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "web_search", arguments: { query: "x" }, thoughtSignature: "fc_12345" }],
        timestamp: 0,
      },
    ]);
    const { body } = await createGoogleAdapter(provider).buildRequest(parsed);
    const wire = JSON.parse(body) as { contents: { role: string; parts: Record<string, unknown>[] }[] };
    const modelPart = wire.contents.find(c => c.role === "model")!.parts[0]!;
    expect(modelPart.thoughtSignature).toBeUndefined();
  });
});

describe("web-search sidecar request body", () => {
  test("replays only the bare hosted web_search tool shape (regression: max_results rejected)", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("sidecar rejected", { status: 500 });
    }) as typeof fetch;

    const forwardProvider = {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.test/v1",
      authMode: "forward",
    } as OcxProviderConfig;
    const outcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer forwarded" }),
      { model: "gpt-5.6-luna", reasoning: "low", timeoutMs: 5_000 },
    );

    expect(capturedBody).toBeDefined();
    expect(capturedBody!.tools).toEqual([{ type: "web_search" }]);
    expect((capturedBody!.tools as Record<string, unknown>[])[0]).not.toHaveProperty("max_results");
    expect((capturedBody!.tools as Record<string, unknown>[])[0]).not.toHaveProperty("search_context_size");
    expect(outcome.error).toContain("sidecar HTTP 500");
  });
});
