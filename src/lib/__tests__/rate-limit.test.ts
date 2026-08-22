import { beforeEach, describe, expect, it } from "vitest";
import { clientKey, rateLimit, rateLimitHeaders, resetRateLimits } from "../rate-limit";
import { redact } from "../logger";

beforeEach(() => resetRateLimits());

describe("rateLimit", () => {
  it("allows requests up to the limit and blocks the one after", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(rateLimit("a", 3, 60_000, 1_000).allowed, `request ${i + 1}`).toBe(true);
    }
    expect(rateLimit("a", 3, 60_000, 1_000).allowed).toBe(false);
  });

  it("counts down the remaining allowance", () => {
    expect(rateLimit("a", 3, 60_000, 1_000).remaining).toBe(2);
    expect(rateLimit("a", 3, 60_000, 1_000).remaining).toBe(1);
    expect(rateLimit("a", 3, 60_000, 1_000).remaining).toBe(0);
  });

  it("never reports a negative allowance once blocked", () => {
    for (let i = 0; i < 6; i += 1) rateLimit("a", 2, 60_000, 1_000);
    expect(rateLimit("a", 2, 60_000, 1_000).remaining).toBe(0);
  });

  it("opens a fresh window once the old one expires", () => {
    rateLimit("a", 1, 60_000, 1_000);
    expect(rateLimit("a", 1, 60_000, 30_000).allowed).toBe(false);
    expect(rateLimit("a", 1, 60_000, 61_001).allowed).toBe(true);
  });

  it("tracks keys independently, so one caller cannot block another", () => {
    rateLimit("a", 1, 60_000, 1_000);
    expect(rateLimit("a", 1, 60_000, 1_000).allowed).toBe(false);
    expect(rateLimit("b", 1, 60_000, 1_000).allowed).toBe(true);
  });

  it("reports a whole-second retry delay when blocked", () => {
    rateLimit("a", 1, 60_000, 1_000);
    const blocked = rateLimit("a", 1, 60_000, 1_500);
    expect(blocked.retryAfterSeconds).toBe(60);
    expect(Number.isInteger(blocked.retryAfterSeconds)).toBe(true);
  });

  it("never reports a zero retry delay on a blocked request", () => {
    rateLimit("a", 1, 60_000, 1_000);
    // 1ms before the window closes still has to round up to at least one second.
    expect(rateLimit("a", 1, 60_000, 60_999).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });
});

describe("rateLimitHeaders", () => {
  it("advertises the limit and remaining allowance", () => {
    const headers = rateLimitHeaders(rateLimit("a", 5, 60_000, 1_000), 5);
    expect(headers["x-ratelimit-limit"]).toBe("5");
    expect(headers["x-ratelimit-remaining"]).toBe("4");
    expect(headers["retry-after"]).toBeUndefined();
  });

  it("adds retry-after only when the request was blocked", () => {
    rateLimit("a", 1, 60_000, 1_000);
    const headers = rateLimitHeaders(rateLimit("a", 1, 60_000, 1_000), 1);
    expect(headers["retry-after"]).toBe("60");
  });
});

describe("clientKey", () => {
  const req = (headers: Record<string, string>) => new Request("http://x/", { headers });

  it("uses the leftmost forwarded address", () => {
    expect(clientKey(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), "run")).toBe("run:1.2.3.4");
  });

  it("falls back to x-real-ip, then to a local marker", () => {
    expect(clientKey(req({ "x-real-ip": "9.9.9.9" }), "run")).toBe("run:9.9.9.9");
    expect(clientKey(req({}), "run")).toBe("run:local");
  });

  it("scopes keys so a limit on one route does not consume another", () => {
    const headers = { "x-forwarded-for": "1.2.3.4" };
    expect(clientKey(req(headers), "run")).not.toBe(clientKey(req(headers), "mcp"));
  });
});

describe("redact", () => {
  it("removes values whose field name looks like a credential", () => {
    const out = redact({ apiKey: "PKLIVE123", secretKey: "abc", nested: { authToken: "xyz" } }) as Record<string, unknown>;
    expect(out.apiKey).toBe("[redacted]");
    expect(out.secretKey).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).authToken).toBe("[redacted]");
  });

  it("removes credential-shaped values even in innocently named fields", () => {
    const out = redact({ message: "failed with sk-ant-api03-abcdefghijkl" }) as Record<string, string>;
    expect(out.message).not.toMatch(/sk-ant-api03-abcdefghijkl/);
    expect(out.message).toMatch(/\[redacted\]/);
  });

  it("redacts an Alpaca key id appearing inside prose", () => {
    const out = redact("using PKABCDEFGHIJKLMNOP now") as string;
    expect(out).not.toMatch(/PKABCDEFGHIJKLMNOP/);
  });

  it("leaves ordinary values untouched", () => {
    expect(redact({ symbol: "QQQ", qty: 2, ok: true })).toEqual({ symbol: "QQQ", qty: 2, ok: true });
  });

  it("does not recurse without bound on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();
  });
});
