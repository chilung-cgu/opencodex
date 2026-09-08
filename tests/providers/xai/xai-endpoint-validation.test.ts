import { afterEach, describe, expect, test } from "bun:test";
import {
  discoverXaiOAuthEndpoints,
  validateXaiEndpoint,
} from "../../../src/oauth/xai";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("xAI endpoint validation (#4048)", () => {
  test("allows trusted auth.x.ai and accounts.x.ai endpoints", () => {
    expect(validateXaiEndpoint("https://auth.x.ai/oauth2/token")).toBe(
      "https://auth.x.ai/oauth2/token"
    );
    expect(validateXaiEndpoint("https://accounts.x.ai/oauth2/token")).toBe(
      "https://accounts.x.ai/oauth2/token"
    );
    expect(validateXaiEndpoint("https://AUTH.X.AI/token")).toBe(
      "https://auth.x.ai/token"
    );
  });

  test("rejects arbitrary x.ai subdomains and root domain", () => {
    expect(() => validateXaiEndpoint("https://evil.x.ai/token")).toThrow(
      /unexpected endpoint/
    );
    expect(() => validateXaiEndpoint("https://anything.x.ai/token")).toThrow(
      /unexpected endpoint/
    );
    expect(() => validateXaiEndpoint("https://x.ai/token")).toThrow(
      /unexpected endpoint/
    );
    expect(() => validateXaiEndpoint("https://api.x.ai/token")).toThrow(
      /unexpected endpoint/
    );
  });

  test("rejects endpoints with embedded userinfo", () => {
    expect(() =>
      validateXaiEndpoint(["https://user:pass", "@", "auth.x.ai/token"].join(""))
    ).toThrow(/unexpected endpoint/);
    expect(() =>
      validateXaiEndpoint(["https://user", "@", "auth.x.ai/token"].join(""))
    ).toThrow(/unexpected endpoint/);
    expect(() =>
      validateXaiEndpoint(["https://:pass", "@", "auth.x.ai/token"].join(""))
    ).toThrow(/unexpected endpoint/);
  });

  test("rejects non-https schemes and non-x.ai domains", () => {
    expect(() => validateXaiEndpoint("http://auth.x.ai/token")).toThrow(
      /unexpected endpoint/
    );
    expect(() => validateXaiEndpoint("https://attacker.com/token")).toThrow(
      /unexpected endpoint/
    );
    expect(() =>
      validateXaiEndpoint("https://auth.x.ai.attacker.com/token")
    ).toThrow(/unexpected endpoint/);
  });

  test("discoverXaiOAuthEndpoints rejects untrusted discovery endpoints", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          authorization_endpoint: "https://auth.x.ai/oauth2/auth",
          token_endpoint: "https://evil.x.ai/oauth2/token",
        })
      )) as typeof fetch;

    await expect(discoverXaiOAuthEndpoints()).rejects.toThrow(
      /unexpected endpoint/
    );
  });
});

