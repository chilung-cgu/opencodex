import { beforeEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../src/adapters/google";
import { __resetAntigravityReplayCache } from "../src/adapters/google-antigravity-replay";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { withTestTranslatorBudget } from "./helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const SIGNATURE = "CiQAx-direct-thought-signature-0123456789abcdef";
const MODEL = "gemini-3.7-flash";

const provider = {
  adapter: "google",
  googleMode: "ai-studio",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKey: "direct-test-key",
} as OcxProviderConfig;

function request(messages: OcxParsedRequest["context"]["messages"], stream: boolean): OcxParsedRequest {
  return {
    modelId: MODEL,
    stream,
    context: {
      messages,
      systemPrompt: [],
      tools: [{ name: "shell_command", description: "run a command", parameters: { type: "object" } }],
    },
    options: {},
  } as unknown as OcxParsedRequest;
}

const firstTurn = (stream: boolean) => request([{ role: "user", content: "run pwd" }], stream);

const continuation = () => request([
  { role: "user", content: "run pwd" },
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call_shell_1",
      name: "shell_command",
      arguments: { command: "pwd" },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "call_shell_1",
    toolName: "shell_command",
    content: "/workspace",
  },
], false);

function scoped(parsed: OcxParsedRequest, threadId: string): OcxParsedRequest {
  parsed._clientThreadId = threadId;
  return parsed;
}

function responseBody(): Record<string, unknown> {
  return {
    candidates: [{
      content: {
        role: "model",
        parts: [{
          functionCall: { name: "shell_command", args: { command: "pwd" } },
          thoughtSignature: SIGNATURE,
        }],
      },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
  };
}

function replayedFunctionCall(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as { contents: Array<{ role?: string; parts?: Record<string, unknown>[] }> };
  const model = parsed.contents.find(content => content.role === "model");
  const part = model?.parts?.find(candidate => "functionCall" in candidate);
  if (!part) throw new Error("compiled direct request omitted the replayed functionCall");
  return part;
}

describe("AI Studio direct thought-signature continuation", () => {
  beforeEach(() => __resetAntigravityReplayCache());

  test("streaming functionCall signature is replayed on the next tool-result turn", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(true));
    const response = new Response(`data: ${JSON.stringify(responseBody())}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
    const events: AdapterEvent[] = [];
    for await (const event of firstAdapter.parseStream(response)) events.push(event);
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");

    const followup = await createGoogleAdapter(provider).buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
  });

  test("non-streaming functionCall signature is replayed unchanged", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(firstTurn(false));
    const events = await firstAdapter.parseResponse!(new Response(JSON.stringify(responseBody())));
    expect(events.some(event => event.type === "tool_call_start")).toBe(true);

    const followup = await createGoogleAdapter(provider).buildRequest(continuation());
    expect(replayedFunctionCall(followup.body as string).thoughtSignature).toBe(SIGNATURE);
  });

  test("signatures do not cross client-thread namespaces", async () => {
    const firstAdapter = createGoogleAdapter(provider);
    await firstAdapter.buildRequest(scoped(firstTurn(false), "thread-a"));
    await firstAdapter.parseResponse!(new Response(JSON.stringify(responseBody())));

    const otherThread = await createGoogleAdapter(provider).buildRequest(scoped(continuation(), "thread-b"));
    expect(replayedFunctionCall(otherThread.body as string).thoughtSignature).toBeUndefined();

    const originalThread = await createGoogleAdapter(provider).buildRequest(scoped(continuation(), "thread-a"));
    expect(replayedFunctionCall(originalThread.body as string).thoughtSignature).toBe(SIGNATURE);
  });
});
