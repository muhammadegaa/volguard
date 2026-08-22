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
