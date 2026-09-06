import { afterEach, describe, expect, it } from "vitest";
import { getConfig, isConfigured, modeIsAllowed } from "../config";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

function configured() {
  process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
  process.env.ALPACA_PAPER_TRADE = "true";
  process.env.ALPACA_API_KEY = "k";
  process.env.ALPACA_SECRET_KEY = "s";
  process.env.ALPACA_ACCOUNT_ID = "PA123";
}

describe("paper-only detection", () => {
  it("treats the paper host as paper", () => {
    configured();
    expect(getConfig().paperOnly).toBe(true);
  });

  it("treats the live host as not paper", () => {
    configured();
    process.env.ALPACA_BASE_URL = "https://api.alpaca.markets";
    expect(getConfig().paperOnly).toBe(false);
    expect(isConfigured()).toBe(false);
  });

  it("honours an explicit paper opt-out", () => {
    configured();
    process.env.ALPACA_PAPER_TRADE = "false";
    expect(getConfig().paperOnly).toBe(false);
  });
});

describe("modeIsAllowed", () => {
  it("always allows dry-run, even with nothing configured", () => {
    process.env.ALPACA_API_KEY = "";
    process.env.ALPACA_SECRET_KEY = "";
    expect(modeIsAllowed("dry-run")).toBe(true);
  });

  it("allows paper only when credentials, paper mode and an account ID are all present", () => {
    configured();
    expect(modeIsAllowed("paper")).toBe(true);
  });

  it("blocks paper without an account ID", () => {
    configured();
    process.env.ALPACA_ACCOUNT_ID = "";
    expect(modeIsAllowed("paper")).toBe(false);
  });

  it("blocks paper against a live URL", () => {
    configured();
    process.env.ALPACA_BASE_URL = "https://api.alpaca.markets";
    expect(modeIsAllowed("paper")).toBe(false);
  });
});

describe("numeric env parsing", () => {
  it("falls back when a value is absent, blank or unparseable", () => {
    delete process.env.VOLGUARD_MAX_LOSS_PER_TRADE;
    expect(getConfig().maxLossPerTrade).toBe(250);
    process.env.VOLGUARD_MAX_LOSS_PER_TRADE = "";
    expect(getConfig().maxLossPerTrade).toBe(250);
    process.env.VOLGUARD_MAX_LOSS_PER_TRADE = "not-a-number";
    expect(getConfig().maxLossPerTrade).toBe(250);
  });

  it("fetches enough bar history for the forecast to beat the trailing estimator", () => {
    delete process.env.VOLGUARD_BAR_SESSIONS;
    // Measured: at 260 the forecast is worse than what it replaces. This default is load-bearing.
    expect(getConfig().barSessions).toBeGreaterThanOrEqual(520);
  });

  it("exposes tunable request throttles with safe defaults", () => {
    delete process.env.VOLGUARD_RUN_RATE_LIMIT;
    delete process.env.VOLGUARD_MCP_RATE_LIMIT;
    expect(getConfig().runRateLimitPerMinute).toBe(30);
    expect(getConfig().mcpRateLimitPerMinute).toBe(10);

    process.env.VOLGUARD_RUN_RATE_LIMIT = "5";
    expect(getConfig().runRateLimitPerMinute).toBe(5);
  });

  it("accepts zero rather than treating it as missing", () => {
    process.env.VOLGUARD_MAX_ENTRY_VRP = "0";
    expect(getConfig().maxEntryVrp).toBe(0);
    process.env.VOLGUARD_MAX_DAILY_LOSS = "0";
    expect(getConfig().maxDailyLoss).toBe(0);
  });

  it("defaults the kill switch to off and only true engages it", () => {
    delete process.env.VOLGUARD_KILL_SWITCH;
    expect(getConfig().killSwitch).toBe(false);
    process.env.VOLGUARD_KILL_SWITCH = "yes";
    expect(getConfig().killSwitch).toBe(false);
    process.env.VOLGUARD_KILL_SWITCH = "true";
    expect(getConfig().killSwitch).toBe(true);
  });

  it("normalises the symbol universe", () => {
    process.env.VOLGUARD_SYMBOLS = " spy , qqq ,, nvda ";
    expect(getConfig().symbols).toEqual(["SPY", "QQQ", "NVDA"]);
  });

  it("only accepts paper as an alternative scheduled mode", () => {
    process.env.VOLGUARD_SCHEDULE_MODE = "live";
    expect(getConfig().scheduleMode).toBe("dry-run");
    process.env.VOLGUARD_SCHEDULE_MODE = "paper";
    expect(getConfig().scheduleMode).toBe("paper");
  });
});

describe("settings validation", () => {
  const issue = (variable: string) => getConfig().issues.find((i) => i.variable === variable);

  it("accepts the shipped defaults with nothing configured", () => {
    expect(getConfig().issues).toEqual([]);
  });

  it("reports a value that is not a number instead of silently using the default", () => {
    // The specific accident: a thousand-dollar cap written with a separator. The old reader
    // returned the $250 default and said nothing, so every later gate reported "passed".
    process.env.VOLGUARD_MAX_LOSS_PER_TRADE = "1,000";
    expect(issue("VOLGUARD_MAX_LOSS_PER_TRADE")?.detail).toMatch(/not a number/);
  });

  it("keeps an out-of-range value rather than substituting a default", () => {
    // Substituting is the behaviour being fixed; the run is refused with the real value named.
    process.env.VOLGUARD_MAX_RISK_PERCENT = "5";
    const config = getConfig();
    expect(config.maxRiskPercent).toBe(5);
    expect(issue("VOLGUARD_MAX_RISK_PERCENT")?.detail).toMatch(/outside the allowed range/);
  });

  it("rejects a negative limit", () => {
    process.env.VOLGUARD_MAX_DAILY_LOSS = "-500";
    expect(issue("VOLGUARD_MAX_DAILY_LOSS")).toBeDefined();
  });

  it("rejects a delta above 1, which no option has", () => {
    process.env.VOLGUARD_LONG_LEG_DELTA = "1.5";
    expect(issue("VOLGUARD_LONG_LEG_DELTA")).toBeDefined();
  });

  it("rejects a debit-to-width above 1, which is a debit larger than the width it can win", () => {
    process.env.VOLGUARD_MAX_DEBIT_TO_WIDTH = "1.4";
    expect(issue("VOLGUARD_MAX_DEBIT_TO_WIDTH")).toBeDefined();
  });

  it("rejects a fractional position count", () => {
    process.env.VOLGUARD_MAX_OPEN_POSITIONS = "2.5";
    expect(issue("VOLGUARD_MAX_OPEN_POSITIONS")?.detail).toMatch(/whole number/);
  });

  it("rejects a run timeout at or above the platform's own function limit", () => {
    // Above this the platform kills the function first and the run is an opaque 504 with
    // nothing recorded, instead of an ERROR the ledger can explain.
    process.env.VOLGUARD_RUN_TIMEOUT_MS = "120000";
    expect(issue("VOLGUARD_RUN_TIMEOUT_MS")).toBeDefined();
  });

  it("rejects a target expiry outside the window the chain is fetched over", () => {
    process.env.VOLGUARD_TARGET_DTE = "90";
    expect(issue("VOLGUARD_TARGET_DTE")?.detail).toMatch(/outside the fetched window/);
  });

  it("rejects a DTE window that cannot contain any expiry", () => {
    process.env.VOLGUARD_MIN_DTE = "40";
    process.env.VOLGUARD_MAX_DTE = "20";
    expect(issue("VOLGUARD_MIN_DTE")).toBeDefined();
  });

  it("rejects a debit spread that would sell the leg nearer the money", () => {
    process.env.VOLGUARD_SHORT_LEG_DELTA = "0.7";
    expect(issue("VOLGUARD_SHORT_LEG_DELTA")).toBeDefined();
  });

  it("rejects a credit spread that would buy the leg nearer the money", () => {
    process.env.VOLGUARD_CREDIT_LONG_LEG_DELTA = "0.4";
    expect(issue("VOLGUARD_CREDIT_LONG_LEG_DELTA")).toBeDefined();
  });

  it("rejects thresholds that would let one premium qualify to both buy and sell", () => {
    process.env.VOLGUARD_MAX_ENTRY_VRP = "0.05";
    expect(issue("VOLGUARD_MAX_ENTRY_VRP")).toBeDefined();
  });

  it("rejects an empty watchlist", () => {
    process.env.VOLGUARD_SYMBOLS = " , ,";
    expect(issue("VOLGUARD_SYMBOLS")).toBeDefined();
  });

  it("names every offending variable, not just the first", () => {
    process.env.VOLGUARD_MAX_RISK_PERCENT = "5";
    process.env.VOLGUARD_MAX_CONTRACTS = "0";
    expect(getConfig().issues.map((i) => i.variable))
      .toEqual(expect.arrayContaining(["VOLGUARD_MAX_RISK_PERCENT", "VOLGUARD_MAX_CONTRACTS"]));
  });
});
