import { afterEach, describe, expect, test } from "bun:test";
import { postXaiToken, XaiTokenRequestError } from "../../../src/oauth/xai";
const original=globalThis.fetch; afterEach(()=>{globalThis.fetch=original;});
function queue(items:Array<Response|Error>){let n=0;globalThis.fetch=(async()=>{const x=items[n++]!;if(x instanceof Error)throw x;return x;}) as typeof fetch;return()=>n;}
const body={grant_type:"refresh_token",client_id:"client",refresh_token:"secret"}; const ok=()=>new Response(JSON.stringify({access_token:"a",refresh_token:"r",expires_in:3600}));
describe("xAI retry",()=>{
 test("network retry succeeds",async()=>{const calls=queue([new Error("net"),ok()]),d:number[]=[];await postXaiToken("https://auth.x.ai/token",body,undefined,{sleep:async x=>{d.push(x)},random:()=>.5});expect(calls()).toBe(2);expect(d).toEqual([100]);});
 test("429 and 5xx retry at most three attempts",async()=>{const calls=queue([new Response("",{status:429}),new Response("",{status:503}),ok()]),d:number[]=[];await postXaiToken("https://auth.x.ai/token",body,undefined,{sleep:async x=>{d.push(x)},random:()=>.5});expect(calls()).toBe(3);expect(d).toEqual([100,250]);});
 test("third transient failure is final",async()=>{const calls=queue([500,502,503].map(status=>new Response("",{status})));await expect(postXaiToken("https://auth.x.ai/token",body,undefined,{sleep:async()=>{},random:()=>.5})).rejects.toMatchObject({status:503});expect(calls()).toBe(3);});
 test("permanent 4xx is not retried or leaked",async()=>{const calls=queue([new Response(JSON.stringify({error:"invalid_grant"}),{status:400})]);await expect(postXaiToken("https://auth.x.ai/token",body,undefined,{sleep:async()=>{}})).rejects.toBeInstanceOf(XaiTokenRequestError);expect(calls()).toBe(1);});
 test("caller abort is not retried",async()=>{const c=new AbortController();c.abort();let calls=0;globalThis.fetch=(async()=>{calls++;throw new DOMException("aborted","AbortError")}) as typeof fetch;await expect(postXaiToken("https://auth.x.ai/token",body,c.signal,{sleep:async()=>{}})).rejects.toMatchObject({name:"AbortError"});expect(calls).toBe(1);});

  test("Retry-After: 60 respects server delay up to 60s without 2s truncation", async () => {
    const calls = queue([new Response("", { status: 429, headers: { "retry-after": "60" } }), ok()]);
    const d: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async x => { d.push(x); },
      random: () => 0.5,
    });
    expect(calls()).toBe(2);
    expect(d).toEqual([60000]);
  });

  test("Retry-After: 1.5 parses decimal seconds into milliseconds", async () => {
    const calls = queue([new Response("", { status: 429, headers: { "retry-after": "1.5" } }), ok()]);
    const d: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async x => { d.push(x); },
      random: () => 0.5,
    });
    expect(calls()).toBe(2);
    expect(d).toEqual([1500]);
  });

  test("Retry-After: HTTP-date format parses future date and past date", async () => {
    const originalNow = Date.now;
    const baseTime = 1700000000000;
    try {
      Date.now = () => baseTime;
      const futureDate = new Date(baseTime + 10000).toUTCString();
      const calls1 = queue([new Response("", { status: 429, headers: { "retry-after": futureDate } }), ok()]);
      const d1: number[] = [];
      await postXaiToken("https://auth.x.ai/token", body, undefined, {
        sleep: async x => { d1.push(x); },
        random: () => 0.5,
      });
      expect(calls1()).toBe(2);
      expect(d1).toEqual([10000]);

      const pastDate = new Date(baseTime - 5000).toUTCString();
      const calls2 = queue([new Response("", { status: 429, headers: { "retry-after": pastDate } }), ok()]);
      const d2: number[] = [];
      await postXaiToken("https://auth.x.ai/token", body, undefined, {
        sleep: async x => { d2.push(x); },
        random: () => 0.5,
      });
      expect(calls2()).toBe(2);
      expect(d2[0]).toBeLessThanOrEqual(100);
    } finally {
      Date.now = originalNow;
    }
  });

  test("caller abort with custom reason is not retried and throws custom reason", async () => {
    const customReason = new Error("user cancel");
    const c = new AbortController();
    c.abort(customReason);
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (init?.signal?.aborted) throw init.signal.reason;
      throw customReason;
    }) as typeof fetch;
    const sleepCalls: number[] = [];
    await expect(
      postXaiToken("https://auth.x.ai/token", body, c.signal, {
        sleep: async ms => { sleepCalls.push(ms); },
      }),
    ).rejects.toBe(customReason);
    expect(calls).toBe(1);
    expect(sleepCalls.length).toBe(0);
  });

  test("Retry-After: extreme values (>60s) are capped at 60s", async () => {
    const calls1 = queue([new Response("", { status: 429, headers: { "retry-after": "120" } }), ok()]);
    const d1: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async x => { d1.push(x); },
      random: () => 0.5,
    });
    expect(calls1()).toBe(2);
    expect(d1).toEqual([60000]);

    const originalNow = Date.now;
    const baseTime = 1700000000000;
    try {
      Date.now = () => baseTime;
      const futureDate = new Date(baseTime + 120000).toUTCString();
      const calls2 = queue([new Response("", { status: 429, headers: { "retry-after": futureDate } }), ok()]);
      const d2: number[] = [];
      await postXaiToken("https://auth.x.ai/token", body, undefined, {
        sleep: async x => { d2.push(x); },
        random: () => 0.5,
      });
      expect(calls2()).toBe(2);
      expect(d2).toEqual([60000]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("Retry-After: 0, negative, and invalid string fall back to default jitter", async () => {
    for (const invalidHeader of ["0", "-1", "-10.5", "invalid-delay", ""]) {
      const calls = queue([new Response("", { status: 429, headers: { "retry-after": invalidHeader } }), ok()]);
      const d: number[] = [];
      await postXaiToken("https://auth.x.ai/token", body, undefined, {
        sleep: async x => { d.push(x); },
        random: () => 0.5,
      });
      expect(calls()).toBe(2);
      expect(d).toEqual([100]);
    }
  });

  test("Retry-After: value smaller than jitter floor uses jitter floor", async () => {
    const calls = queue([new Response("", { status: 429, headers: { "retry-after": "0.05" } }), ok()]);
    const d: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async x => { d.push(x); },
      random: () => 0.5,
    });
    expect(calls()).toBe(2);
    expect(d).toEqual([100]);
  });

  test("Retry-After: leading dot decimal (.5) and whitespace are handled", async () => {
    const calls = queue([new Response("", { status: 429, headers: { "retry-after": "  .5  " } }), ok()]);
    const d: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async x => { d.push(x); },
      random: () => 0.5,
    });
    expect(calls()).toBe(2);
    expect(d).toEqual([500]);
  });

  test("Retry-After > 60s is capped at 60000ms", async () => {
    const calls = queue([new Response("", { status: 429, headers: { "retry-after": "3600" } }), ok()]);
    const d: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async x => { d.push(x); },
      random: () => 0.5,
    });
    expect(calls()).toBe(2);
    expect(d).toEqual([60000]);
  });

  test("transient connection timeout without caller abort is retried", async () => {
    const timeoutErr = new DOMException("The operation timed out.", "TimeoutError");
    const calls = queue([timeoutErr, ok()]);
    const d: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async x => { d.push(x); },
      random: () => 0.5,
    });
    expect(calls()).toBe(2);
    expect(d).toEqual([100]);
  });

  test("abort during retry backoff does not start another token request", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancel during backoff");
    const calls = queue([new Response("", { status: 429 }), ok()]);
    const sleepCalls: number[] = [];
    await expect(
      postXaiToken("https://auth.x.ai/token", body, controller.signal, {
        sleep: async ms => {
          sleepCalls.push(ms);
          controller.abort(reason);
        },
        random: () => 0.5,
      }),
    ).rejects.toBe(reason);
    expect(calls()).toBe(1);
    expect(sleepCalls).toEqual([100]);
  });

  test("an undefined network rejection is retried when the caller signal is not aborted", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw undefined;
    }) as typeof fetch;
    const sleepCalls: number[] = [];
    await expect(
      postXaiToken("https://auth.x.ai/token", body, undefined, {
        sleep: async ms => { sleepCalls.push(ms); },
        random: () => 0.5,
      }),
    ).rejects.toMatchObject({ name: "XaiTokenRequestError", cause: undefined });
    expect(calls).toBe(3);
    expect(sleepCalls).toEqual([100, 250]);
  });

  test("Retry-After accepts only HTTP-date forms, not arbitrary date strings", async () => {
    const calls = queue([
      new Response("", { status: 429, headers: { "retry-after": "2027-01-01" } }),
      ok(),
    ]);
    const delays: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async ms => { delays.push(ms); },
      random: () => 0.5,
    });
    expect(calls()).toBe(2);
    expect(delays).toEqual([100]);
  });

  test("Retry-After rejects a trailing decimal point", async () => {
    const calls = queue([
      new Response("", { status: 429, headers: { "retry-after": "1." } }),
      ok(),
    ]);
    const delays: number[] = [];
    await postXaiToken("https://auth.x.ai/token", body, undefined, {
      sleep: async ms => { delays.push(ms); },
      random: () => 0.5,
    });
    expect(calls()).toBe(2);
    expect(delays).toEqual([100]);
  });

  test("default retry backoff is interrupted by caller abort", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancel during default backoff");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 429, headers: { "retry-after": "1" } });
    }) as typeof fetch;
    const started = performance.now();
    const pending = postXaiToken("https://auth.x.ai/token", body, controller.signal, { random: () => 0.5 });
    setTimeout(() => controller.abort(reason), 5);
    await expect(pending).rejects.toBe(reason);
    expect(calls).toBe(1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("default retry backoff preserves a null caller abort reason", async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("", { status: 429, headers: { "retry-after": "1" } });
    }) as typeof fetch;
    const pending = postXaiToken("https://auth.x.ai/token", body, controller.signal, { random: () => 0.5 });
    setTimeout(() => controller.abort(null), 5);
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(null);
    expect(calls).toBe(1);
  });

  test("caller abort during the final error body read wins over the terminal HTTP error", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancel during error body");
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: false,
        status: 503,
        headers: new Headers(),
        json: async () => {
          if (calls === 3) setTimeout(() => controller.abort(reason), 5);
          await new Promise(resolve => setTimeout(resolve, 15));
          return {};
        },
      } as Response;
    }) as typeof fetch;
    let caught: unknown;
    try {
      await postXaiToken("https://auth.x.ai/token", body, controller.signal, {
        sleep: async () => {},
        random: () => 0.5,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(calls).toBe(3);
  });

  test("caller abort races a custom retry sleep instead of waiting for it", async () => {
    const controller = new AbortController();
    const reason = new Error("user cancel during custom backoff");
    const calls = queue([new Response("", { status: 429 }), ok()]);
    const started = performance.now();
    setTimeout(() => controller.abort(reason), 5);
    await expect(
      postXaiToken("https://auth.x.ai/token", body, controller.signal, {
        sleep: async () => {
          await new Promise(resolve => setTimeout(resolve, 100));
        },
        random: () => 0.5,
      }),
    ).rejects.toBe(reason);
    expect(calls()).toBe(1);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
