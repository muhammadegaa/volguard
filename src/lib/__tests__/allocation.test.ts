import { afterEach, describe, expect, it } from "vitest";
import { clientOrderIdFor, planAllocation, type AllocationCandidate } from "../allocation";
import { getConfig } from "../config";
import type { MarketObservation, StrategyKind, TradeThesis } from "../types";
import { account, chainRow, paperEnv } from "./fixtures";

const ORIGINAL = { ...process.env };
const NOW = new Date("2026-08-19T16:00:00Z");
const TODAY = "2026-08-19";

afterEach(() => {
  process.env = { ...ORIGINAL };
});

const fresh = () => new Date(NOW.getTime() - 5000).toISOString();

/**
 * A $5-wide call debit spread. The selector crosses at the ask on the buy leg and the bid
 * on the sell leg, so the net debit is 8.00 − 7.00 = $1.00 and one spread risks exactly
 * $100 — every assertion below is checkable by hand.
 */
function chain(symbol: string) {
  return [
    chainRow({ symbol: `${symbol}260918C00500000`, strike: 500, delta: 0.55, bid: 7.95, ask: 8.0, mid: 7.975, quoteTime: fresh() }),
    chainRow({ symbol: `${symbol}260918C00505000`, strike: 505, delta: 0.27, bid: 7.0, ask: 7.05, mid: 7.025, quoteTime: fresh() }),
  ];
}

function observation(symbol: string): MarketObservation {
  return {
    symbol,
    price: 500,
    previousClose: 499,
    dailyReturn: 0.002,
    trend: 0.01,
    volatility: {
      realizedVol20: 0.25, realizedVol10: 0.25, realizedVol5: 0.25,
      bipowerVol20: 0.24, jumpFraction: 0.1, parkinsonVol20: 0.24, realizedVolRank: 0.5,
      atmImpliedVol: 0.18, frontImpliedVol: 0.18, backImpliedVol: 0.19, termSlope: 0.01,
      forecastVol: 0.24, forecastSource: "har", forecastHorizonDays: 30, forecastR2: 0.4,
      varianceRiskPremium: -0.06, trailingVarianceRiskPremium: -0.06,
      skew25: 0.02, impliedVolRank: null, ivSamples: 3,
    },
    event: { severity: "low", score: 10, drivers: [], newsCount: 0, matchedHeadlines: [], corporateActions: [] },
    targetExpiry: "2026-09-18",
    daysToExpiry: 30,
    chainContracts: 2,
    dataAsOf: NOW.toISOString(),
    source: "alpaca",
    unavailable: [],
  };
}

function thesis(symbol: string, strategy: StrategyKind = "bull_call_debit_spread"): TradeThesis {
  return {
    symbol,
    direction: "bullish",
    thesis: "Implied volatility is below forecast realized volatility.",
    catalyst: "Cheap optionality.",
    invalidation: "Exit at the stop or the time stop.",
    confidence: 0.6,
    strategy,
    source: "rules_fallback",
  };
}

function candidates(...symbols: string[]): AllocationCandidate[] {
  return symbols.map((symbol) => ({
    observation: observation(symbol),
    verdict: { strategy: "bull_call_debit_spread" as const, direction: "bullish" as const, confidence: 0.6, rationale: [], verdict: "cheap vol" },
    rows: chain(symbol),
    thesis: thesis(symbol),
  }));
}

function plan(overrides: Partial<Parameters<typeof planAllocation>[0]> = {}) {
  return planAllocation({
    candidates: candidates("SPY", "QQQ", "IWM", "DIA"),
    account,
    config: getConfig(),
    marketOpen: true,
    openPositionCount: 0,
    openRiskDollars: 0,
    dailyLossUsed: 0,
    today: TODAY,
    now: NOW,
    ...overrides,
  });
}

const opened = (decisions: ReturnType<typeof plan>) => decisions.filter((d) => d.status === "TRADE_APPROVED");

describe("the allocator spends one budget across many candidates", () => {
  it("opens several distinct underlyings in a single run", () => {
    // $500 daily budget, $250 per trade, $100 of risk per spread: 2 lots, 2 lots, then 1.
    paperEnv({ VOLGUARD_MAX_DAILY_LOSS: "500", VOLGUARD_MAX_OPEN_POSITIONS: "5" });
    const approved = opened(plan());

    expect(approved).toHaveLength(3);
    expect(approved.map((d) => d.symbol)).toEqual(["SPY", "QQQ", "IWM"]);
    expect(approved.map((d) => d.orderIntent!.maxLoss)).toEqual([200, 200, 100]);
  });

  it("opens exactly one when the budget only affords one", () => {
    paperEnv({ VOLGUARD_MAX_DAILY_LOSS: "200", VOLGUARD_MAX_OPEN_POSITIONS: "5" });
    const decisions = plan();

    expect(opened(decisions)).toHaveLength(1);
    // The rest are not silently dropped — each says the budget is what stopped it.
    expect(decisions[1].status).toBe("NO_TRADE");
    expect(decisions[1].message).toMatch(/remaining risk budget/);
  });

  it("advances to the next candidate when the leading one is exhausted", () => {
    // One position per underlying per day is enforced by the client order id, so a symbol
    // already traded today must not end the run — it must yield its budget to the next.
    paperEnv({ VOLGUARD_MAX_DAILY_LOSS: "500", VOLGUARD_MAX_OPEN_POSITIONS: "5" });
    const decisions = plan({
      duplicateClientOrderIds: new Set([clientOrderIdFor(TODAY, "SPY", "bull_call_debit_spread")]),
    });

    expect(decisions[0].status).toBe("TRADE_REJECTED");
    expect(decisions[0].risk!.reasons.join(" ")).toMatch(/no_duplicate_order/);
    expect(opened(decisions).map((d) => d.symbol)).toEqual(["QQQ", "IWM", "DIA"]);
  });

  it("counts each new position against the open-position cap, not just the pre-existing ones", () => {
    paperEnv({ VOLGUARD_MAX_DAILY_LOSS: "5000", VOLGUARD_MAX_OPEN_POSITIONS: "3" });
    // Two spreads are already open, so exactly one slot is left however much budget remains.
    const decisions = plan({ openPositionCount: 2 });

    expect(opened(decisions)).toHaveLength(1);
    expect(decisions[1].risk!.reasons.join(" ")).toMatch(/open_positions/);
  });

  it("does not open anything while the market is closed", () => {
    paperEnv({ VOLGUARD_MAX_DAILY_LOSS: "5000", VOLGUARD_MAX_OPEN_POSITIONS: "5" });
    const decisions = plan({ marketOpen: false });

    expect(opened(decisions)).toHaveLength(0);
    expect(decisions.every((d) => d.status === "TRADE_REJECTED")).toBe(true);
  });

  it("records a model veto per symbol without spending any budget on it", () => {
    paperEnv({ VOLGUARD_MAX_DAILY_LOSS: "500", VOLGUARD_MAX_OPEN_POSITIONS: "5" });
    const list = candidates("SPY", "QQQ");
    list[0].thesis = thesis("SPY", "no_trade");
    const decisions = plan({ candidates: list });

    expect(decisions[0].status).toBe("NO_TRADE");
    expect(decisions[0].orderIntent).toBeNull();
    // The vetoed symbol left the whole budget to the next candidate.
    expect(decisions[1].orderIntent!.maxLoss).toBe(200);
  });
});

describe("the portfolio invariant the per-trade gates cannot enforce", () => {
  it("never lets the risk opened in one run exceed the portfolio cap", () => {
    // The defect this guards against: every per-trade gate compares one intent against the
    // limits, so without accumulators N candidates each pass while the portfolio breaches.
    for (const capPercent of [0.001, 0.002, 0.003, 0.005, 0.01, 0.05]) {
      paperEnv({
        VOLGUARD_MAX_DAILY_LOSS: "100000",
        VOLGUARD_MAX_OPEN_POSITIONS: "20",
        VOLGUARD_MAX_PORTFOLIO_RISK_PERCENT: String(capPercent),
      });
      const cap = Number(account.equity) * capPercent;
      const total = opened(plan()).reduce((sum, d) => sum + d.orderIntent!.maxLoss, 0);
      expect(total, `portfolio cap ${capPercent} breached`).toBeLessThanOrEqual(cap);
    }
  });

  it("never lets the risk opened in one run exceed the daily loss budget", () => {
    for (const budget of [50, 100, 250, 400, 500, 1000]) {
      paperEnv({ VOLGUARD_MAX_DAILY_LOSS: String(budget), VOLGUARD_MAX_OPEN_POSITIONS: "20" });
      const total = opened(plan()).reduce((sum, d) => sum + d.orderIntent!.maxLoss, 0);
      expect(total, `daily budget ${budget} breached`).toBeLessThanOrEqual(budget);
    }
  });

  it("respects loss already taken today when deciding what is left to risk", () => {
    paperEnv({ VOLGUARD_MAX_DAILY_LOSS: "500", VOLGUARD_MAX_OPEN_POSITIONS: "20" });
    const total = opened(plan({ dailyLossUsed: 350 })).reduce((sum, d) => sum + d.orderIntent!.maxLoss, 0);
    expect(total).toBeLessThanOrEqual(150);
  });
});
