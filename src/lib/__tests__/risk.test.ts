import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateRisk } from "../risk";
import { account, creditIntent, intent, leg, paperEnv, riskBase } from "./fixtures";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllEnvs();
});

function failed(decision: ReturnType<typeof evaluateRisk>, name: string) {
  return decision.checks.find((check) => check.name === name && !check.passed);
}

describe("evaluateRisk", () => {
  it("approves a clean, fully compliant defined-risk spread", () => {
    paperEnv();
    const decision = evaluateRisk({ ...riskBase(), intent: intent() });
    expect(decision.reasons).toEqual([]);
    expect(decision.approved).toBe(true);
  });

  it("checks every configured limit, so no limit can exist in config without a gate", () => {
    paperEnv();
    const names = evaluateRisk({ ...riskBase(), intent: intent() }).checks.map((check) => check.name);
    for (const required of [
      "paper_environment", "kill_switch", "account_status", "options_level", "market_open",
      "two_leg_spread", "defined_risk", "same_expiry", "same_option_type", "all_option_legs",
      "price_below_width", "positive_net_price", "max_loss_matches_width",
      "equal_leg_ratios", "credit_spreads_enabled", "whole_quantity", "time_in_force",
      "quote_freshness", "spread_quality", "quote_depth",
      "max_loss_per_trade", "equity_risk", "daily_loss_limit", "portfolio_exposure",
      "open_positions", "buying_power", "no_duplicate_order",
    ]) {
      expect(names, `missing gate: ${required}`).toContain(required);
    }
  });

  it("rejects a live (non-paper) endpoint", () => {
    paperEnv({ ALPACA_BASE_URL: "https://api.alpaca.markets" });
    const decision = evaluateRisk({ ...riskBase(), intent: intent() });
    expect(decision.approved).toBe(false);
    expect(failed(decision, "paper_environment")).toBeDefined();
  });

  it("rejects everything when the kill switch is engaged", () => {
    paperEnv({ VOLGUARD_KILL_SWITCH: "true" });
    const decision = evaluateRisk({ ...riskBase(), intent: intent() });
    expect(decision.approved).toBe(false);
    expect(failed(decision, "kill_switch")).toBeDefined();
  });

  it("rejects an inactive account", () => {
    paperEnv();
    const decision = evaluateRisk({ ...riskBase(), account: { ...account, status: "ACCOUNT_CLOSED" }, intent: intent() });
    expect(failed(decision, "account_status")).toBeDefined();
  });

  it("rejects an order while the market is closed, even though the scan still runs", () => {
    paperEnv();
    const decision = evaluateRisk({ ...riskBase(), marketOpen: false, intent: intent() });
    expect(decision.approved).toBe(false);
    expect(failed(decision, "market_open")).toBeDefined();
  });

  it("rejects an order when Alpaca's clock could not be read", () => {
    paperEnv();
    expect(failed(evaluateRisk({ ...riskBase(), marketOpen: null, intent: intent() }), "market_open")).toBeDefined();
  });

  it("rejects an account below options level 3", () => {
    paperEnv();
    const decision = evaluateRisk({ ...riskBase(), account: { ...account, options_trading_level: 2 }, intent: intent() });
    expect(failed(decision, "options_level")).toBeDefined();
  });

  it("rejects a max loss above the per-trade dollar limit", () => {
    paperEnv({ VOLGUARD_MAX_LOSS_PER_TRADE: "50" });
    expect(failed(evaluateRisk({ ...riskBase(), intent: intent() }), "max_loss_per_trade")).toBeDefined();
  });

  it("rejects a max loss above the equity percentage limit", () => {
    paperEnv({ VOLGUARD_MAX_RISK_PERCENT: "0.0005" });
    expect(failed(evaluateRisk({ ...riskBase(), intent: intent() }), "equity_risk")).toBeDefined();
  });

  it("rejects a trade that would breach the daily loss budget", () => {
    paperEnv({ VOLGUARD_MAX_DAILY_LOSS: "500" });
    const decision = evaluateRisk({ ...riskBase(), dailyLossUsed: 450, intent: intent() });
    expect(failed(decision, "daily_loss_limit")).toBeDefined();
  });

  it("rejects a trade that would breach the portfolio exposure cap", () => {
    paperEnv({ VOLGUARD_MAX_PORTFOLIO_RISK_PERCENT: "0.001" });
    expect(failed(evaluateRisk({ ...riskBase(), openRiskDollars: 90, intent: intent() }), "portfolio_exposure")).toBeDefined();
  });

  it("rejects when the maximum open position count is already reached", () => {
    paperEnv({ VOLGUARD_MAX_OPEN_POSITIONS: "2" });
    expect(failed(evaluateRisk({ ...riskBase(), openPositionCount: 2, intent: intent() }), "open_positions")).toBeDefined();
  });

  it("rejects a stale quote", () => {
    paperEnv({ VOLGUARD_MAX_QUOTE_AGE_SECONDS: "30" });
    const stale = intent({ legs: [leg({ symbol: "A", quoteAgeSeconds: 500 }), leg({ symbol: "B", side: "sell", positionIntent: "sell_to_open", strike: 105 })] });
    expect(failed(evaluateRisk({ ...riskBase(), intent: stale }), "quote_freshness")).toBeDefined();
  });

  it("rejects a missing quote timestamp rather than treating it as fresh", () => {
    paperEnv();
    const noTime = intent({ legs: [leg({ symbol: "A", quoteAgeSeconds: null }), leg({ symbol: "B", side: "sell", positionIntent: "sell_to_open", strike: 105 })] });
    expect(failed(evaluateRisk({ ...riskBase(), intent: noTime }), "quote_freshness")).toBeDefined();
  });

  it("rejects a leg whose bid/ask spread is too wide", () => {
    paperEnv({ VOLGUARD_MAX_SPREAD_PERCENT: "0.02" });
    const wide = intent({ legs: [leg({ symbol: "A", bid: 1.0, ask: 2.0, mid: 1.5 }), leg({ symbol: "B", side: "sell", positionIntent: "sell_to_open", strike: 105 })] });
    expect(failed(evaluateRisk({ ...riskBase(), intent: wide }), "spread_quality")).toBeDefined();
  });

  it("rejects a leg with insufficient displayed depth", () => {
    paperEnv({ VOLGUARD_MIN_QUOTE_SIZE: "25" });
    const thin = intent({ legs: [leg({ symbol: "A", bidSize: 1, askSize: 1 }), leg({ symbol: "B", side: "sell", positionIntent: "sell_to_open", strike: 105 })] });
    expect(failed(evaluateRisk({ ...riskBase(), intent: thin }), "quote_depth")).toBeDefined();
  });

  it("rejects a duplicate client order id", () => {
    paperEnv();
    const decision = evaluateRisk({ ...riskBase(), duplicateClientOrderId: true, intent: intent() });
    expect(decision.approved).toBe(false);
    expect(failed(decision, "no_duplicate_order")).toBeDefined();
  });

  it("rejects a structure that is not a two-leg spread", () => {
    paperEnv();
    const single = intent({ legs: [leg({ symbol: "A" })] });
    expect(failed(evaluateRisk({ ...riskBase(), intent: single }), "two_leg_spread")).toBeDefined();
  });

  it("rejects legs with mismatched expiries or option types", () => {
    paperEnv();
    const mismatched = intent({
      legs: [
        leg({ symbol: "A", expirationDate: "2026-09-18", type: "call" }),
        leg({ symbol: "B", side: "sell", positionIntent: "sell_to_open", expirationDate: "2026-10-16", type: "put" }),
      ],
    });
    const decision = evaluateRisk({ ...riskBase(), intent: mismatched });
    expect(failed(decision, "same_expiry")).toBeDefined();
    expect(failed(decision, "same_option_type")).toBeDefined();
  });

  it("rejects a premium that is not below the strike width", () => {
    paperEnv();
    expect(failed(evaluateRisk({ ...riskBase(), intent: intent({ limitPrice: 6, width: 5 }) }), "price_below_width")).toBeDefined();
  });

  it("rejects a fractional quantity", () => {
    paperEnv();
    expect(failed(evaluateRisk({ ...riskBase(), intent: intent({ qty: 1.5 }) }), "whole_quantity")).toBeDefined();
  });

  it("treats reward:risk and open interest as advisory, not blocking", () => {
    paperEnv();
    const poor = intent({ rewardRisk: 0.1, legs: [leg({ symbol: "A", openInterest: 0 }), leg({ symbol: "B", side: "sell", positionIntent: "sell_to_open", strike: 105, openInterest: 0 })] });
    const decision = evaluateRisk({ ...riskBase(), intent: poor });
    expect(decision.approved).toBe(true);
    expect(decision.checks.find((c) => c.name === "reward_risk")?.blocking).toBe(false);
  });
});

describe("the engine guarantees definedness, independently of the selector", () => {
  it("approves a clean credit spread when premium selling is enabled", () => {
    paperEnv({ VOLGUARD_SELL_PREMIUM_ENABLED: "true", VOLGUARD_MAX_LOSS_PER_TRADE: "500" });
    const decision = evaluateRisk({ ...riskBase(), intent: creditIntent() });
    expect(decision.reasons).toEqual([]);
    expect(decision.approved).toBe(true);
  });

  it("blocks a credit spread when premium selling is switched off", () => {
    paperEnv({ VOLGUARD_SELL_PREMIUM_ENABLED: "false", VOLGUARD_MAX_LOSS_PER_TRADE: "500" });
    expect(failed(evaluateRisk({ ...riskBase(), intent: creditIntent() }), "credit_spreads_enabled")).toBeDefined();
  });

  it("reserves margin for a credit spread, not its maximum loss", () => {
    // Max loss $350 fits the buying power; the $500 width does not. Comparing max loss —
    // as the gate used to — would under-reserve and let the order through.
    paperEnv({ VOLGUARD_SELL_PREMIUM_ENABLED: "true", VOLGUARD_MAX_LOSS_PER_TRADE: "500" });
    const poor = { ...account, buying_power: "400", cash: "400" };
    const decision = evaluateRisk({ ...riskBase(), account: poor, intent: creditIntent() });
    expect(failed(decision, "buying_power")).toBeDefined();
  });

  it("rejects a tampered intent whose maximum loss does not exhaust the width", () => {
    paperEnv({ VOLGUARD_SELL_PREMIUM_ENABLED: "true", VOLGUARD_MAX_LOSS_PER_TRADE: "500" });
    // Understating max loss is how a naked or mis-sized structure would slip through.
    const tampered = creditIntent({ maxLoss: 50 });
    expect(failed(evaluateRisk({ ...riskBase(), intent: tampered }), "max_loss_matches_width")).toBeDefined();
  });

  it("rejects a ratio spread, which is unbounded even though it is two legs", () => {
    paperEnv();
    const ratio = intent({
      legs: [
        leg({ symbol: "A", ratioQty: 1 }),
        leg({ symbol: "B", side: "sell", positionIntent: "sell_to_open", strike: 105, ratioQty: 2 }),
      ],
    });
    expect(failed(evaluateRisk({ ...riskBase(), intent: ratio }), "equal_leg_ratios")).toBeDefined();
  });

  it("rejects two sold legs, which is naked however the selector labelled it", () => {
    paperEnv();
    const naked = intent({
      legs: [
        leg({ symbol: "A", side: "sell", positionIntent: "sell_to_open" }),
        leg({ symbol: "B", side: "sell", positionIntent: "sell_to_open", strike: 105 }),
      ],
    });
    expect(failed(evaluateRisk({ ...riskBase(), intent: naked }), "defined_risk")).toBeDefined();
  });
});
