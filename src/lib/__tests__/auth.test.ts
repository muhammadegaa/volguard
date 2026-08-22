import { afterEach, describe, expect, it } from "vitest";
import { hasOperatorToken, hasScheduleAuthorization, secretMatches } from "../auth";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const req = (headers: Record<string, string>) => new Request("https://volguard.test/api", { headers });

describe("secretMatches", () => {
  it("matches an exact secret", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong secret, including a prefix of the real one", () => {
    expect(secretMatches("s3cret", "s3cre")).toBe(false);
    expect(secretMatches("s3cret", "s3cretX")).toBe(false);
    expect(secretMatches("s3cret", "wrong")).toBe(false);
  });

  it("never matches when the expected secret is unset or empty", () => {
    expect(secretMatches(undefined, "anything")).toBe(false);
    expect(secretMatches("", "")).toBe(false);
  });

  it("never matches a missing provided value", () => {
    expect(secretMatches("s3cret", null)).toBe(false);
    expect(secretMatches("s3cret", "")).toBe(false);
  });

  it("compares secrets of differing length without throwing", () => {
    expect(() => secretMatches("short", "a-much-longer-provided-value")).not.toThrow();
    expect(secretMatches("short", "a-much-longer-provided-value")).toBe(false);
  });
});

describe("hasOperatorToken", () => {
  it("accepts the configured token", () => {
    process.env.VOLGUARD_OPERATOR_TOKEN = "op-token";
    expect(hasOperatorToken(req({ "x-volguard-token": "op-token" }))).toBe(true);
  });

  it("rejects a wrong or absent token", () => {
    process.env.VOLGUARD_OPERATOR_TOKEN = "op-token";
    expect(hasOperatorToken(req({ "x-volguard-token": "nope" }))).toBe(false);
    expect(hasOperatorToken(req({}))).toBe(false);
  });

  it("rejects everything when no token is configured, rather than allowing all", () => {
    delete process.env.VOLGUARD_OPERATOR_TOKEN;
    expect(hasOperatorToken(req({ "x-volguard-token": "anything" }))).toBe(false);
  });
});

describe("hasScheduleAuthorization", () => {
  it("accepts the operator token", () => {
    process.env.VOLGUARD_OPERATOR_TOKEN = "op-token";
    expect(hasScheduleAuthorization(req({ "x-volguard-token": "op-token" }))).toBe(true);
  });

  it("accepts a Vercel cron bearer secret", () => {
    process.env.CRON_SECRET = "cron-secret";
    expect(hasScheduleAuthorization(req({ authorization: "Bearer cron-secret" }))).toBe(true);
  });

  it("rejects a wrong bearer secret", () => {
    process.env.CRON_SECRET = "cron-secret";
    expect(hasScheduleAuthorization(req({ authorization: "Bearer wrong" }))).toBe(false);
  });

  it("rejects a non-bearer authorization scheme", () => {
    process.env.CRON_SECRET = "cron-secret";
    expect(hasScheduleAuthorization(req({ authorization: "Basic cron-secret" }))).toBe(false);
  });

  it("rejects an unauthenticated request", () => {
    process.env.VOLGUARD_OPERATOR_TOKEN = "op-token";
    process.env.CRON_SECRET = "cron-secret";
    expect(hasScheduleAuthorization(req({}))).toBe(false);
  });

  it("rejects everything when neither secret is configured", () => {
    delete process.env.VOLGUARD_OPERATOR_TOKEN;
    delete process.env.CRON_SECRET;
    expect(hasScheduleAuthorization(req({ authorization: "Bearer x", "x-volguard-token": "y" }))).toBe(false);
  });
});
