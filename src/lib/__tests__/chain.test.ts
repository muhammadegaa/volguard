import { describe, expect, it } from "vitest";
import { assessLiquidity, buildOrderIntent, orderPayload, quoteAgeSeconds, selectDebitSpread } from "../chain";
import type { VolGuardConfig } from "../config";
import { chainRow, intent } from "./fixtures";

const NOW = new Date("2026-08-19T16:00:00Z");

const config = {
  maxSpreadPercent: 0.08,
  maxQuoteAgeSeconds: 90,
  minQuoteSize: 5,
  longLegDelta: 0.55,
  shortLegDelta: 0.27,
  maxDebitToWidth: 0.7,
  maxLossPerTrade: 250,
  maxRiskPercent: 0.01,
  maxContracts: 5,
  takeProfitPercent: 0.5,
  stopLossPercent: 0.5,
  timeStopDte: 7,
} as VolGuardConfig;

const fresh = (offsetSeconds = 5) => new Date(NOW.getTime() - offsetSeconds * 1000).toISOString();

function callChain() {
  return [
    chainRow({ symbol: "SPY260918C00500000", strike: 500, delta: 0.55, bid: 8.0, ask: 8.1, mid: 8.05, quoteTime: fresh() }),
    chainRow({ symbol: "SPY260918C00505000", strike: 505, delta: 0.27, bid: 5.0, ask: 5.1, mid: 5.05, quoteTime: fresh() }),
  ];
}

describe("quoteAgeSeconds", () => {
  it("measures age from the quote timestamp", () => {
    expect(quoteAgeSeconds(fresh(30), NOW)).toBeCloseTo(30, 0);
  });
  it("returns null for a missing or unparseable timestamp", () => {
    expect(quoteAgeSeconds(null, NOW)).toBeNull();
    expect(quoteAgeSeconds("not-a-date", NOW)).toBeNull();
  });
});

describe("assessLiquidity", () => {
  it("passes a fresh, tight, two-sided quote with depth", () => {
    expect(assessLiquidity(callChain()[0], config, NOW).passed).toBe(true);
  });

  it("fails a one-sided quote", () => {
    const row = chainRow({ symbol: "X", bid: null, mid: null, quoteTime: fresh() });
    const report = assessLiquidity(row, config, NOW);
    expect(report.passed).toBe(false);
    expect(report.detail).toMatch(/two-sided/);
  });

  it("fails a stale quote", () => {
    const report = assessLiquidity(chainRow({ symbol: "X", quoteTime: fresh(600) }), config, NOW);
    expect(report.passed).toBe(false);
    expect(report.detail).toMatch(/old/);
  });

  it("fails a wide quote", () => {
    const row = chainRow({ symbol: "X", bid: 0.03, ask: 0.08, mid: 0.055, quoteTime: fresh() });
    const report = assessLiquidity(row, config, NOW);
    expect(report.passed).toBe(false);
    expect(report.detail).toMatch(/spread/);
  });

  it("fails a quote with no displayed depth", () => {
    const row = chainRow({ symbol: "X", bidSize: 1, askSize: 1, quoteTime: fresh() });
    expect(assessLiquidity(row, config, NOW).passed).toBe(false);
  });
});

describe("selectDebitSpread", () => {
  it("builds a call debit spread long the lower strike", () => {
    const candidate = selectDebitSpread({ rows: callChain(), strategy: "bull_call_debit_spread", config, now: NOW });
    expect(candidate?.rejection).toBeNull();
    expect(candidate?.longLeg.strike).toBe(500);
    expect(candidate?.shortLeg.strike).toBe(505);
    // Debit is ask on the long leg minus bid on the short leg, never mid-to-mid.
    expect(candidate?.debit).toBeCloseTo(3.1, 2);
    expect(candidate?.width).toBe(5);
  });

  it("builds a put debit spread long the higher strike", () => {
    const rows = [
      chainRow({ symbol: "SPY260918P00500000", type: "put", strike: 500, delta: -0.55, bid: 8.0, ask: 8.1, mid: 8.05, quoteTime: fresh() }),
      chainRow({ symbol: "SPY260918P00495000", type: "put", strike: 495, delta: -0.27, bid: 5.0, ask: 5.1, mid: 5.05, quoteTime: fresh() }),
    ];
    const candidate = selectDebitSpread({ rows, strategy: "bear_put_debit_spread", config, now: NOW });
    expect(candidate?.rejection).toBeNull();
    expect(candidate?.longLeg.strike).toBe(500);
    expect(candidate?.shortLeg.strike).toBe(495);
  });

  it("rejects a debit that is too large a fraction of the width", () => {
    const rows = [
      chainRow({ symbol: "A", strike: 500, delta: 0.55, bid: 8.0, ask: 8.1, mid: 8.05, quoteTime: fresh() }),
      chainRow({ symbol: "B", strike: 505, delta: 0.27, bid: 3.9, ask: 4.0, mid: 3.95, quoteTime: fresh() }),
    ];
    const candidate = selectDebitSpread({ rows, strategy: "bull_call_debit_spread", config, now: NOW });
    expect(candidate?.rejection).toMatch(/% of width/);
  });

  it("rejects a non-positive debit rather than proposing a credit", () => {
    const rows = [
      chainRow({ symbol: "A", strike: 500, delta: 0.55, bid: 4.0, ask: 4.1, mid: 4.05, quoteTime: fresh() }),
      chainRow({ symbol: "B", strike: 505, delta: 0.27, bid: 5.0, ask: 5.1, mid: 5.05, quoteTime: fresh() }),
    ];
    expect(selectDebitSpread({ rows, strategy: "bull_call_debit_spread", config, now: NOW })?.rejection)
      .toMatch(/not positive/);
  });

  it("propagates a stale-quote rejection from the legs", () => {
    const rows = callChain().map((row) => ({ ...row, quoteTime: fresh(9999) }));
    expect(selectDebitSpread({ rows, strategy: "bull_call_debit_spread", config, now: NOW })?.rejection).toMatch(/old/);
  });

  it("returns null when the chain has fewer than two contracts of the needed type", () => {
    expect(selectDebitSpread({ rows: [callChain()[0]], strategy: "bull_call_debit_spread", config, now: NOW })).toBeNull();
  });

  it("skips a thin strike and picks a viable pair instead of vetoing the expiry", () => {
    const rows = [
      // Nearest to the 0.55 delta target, but only 2 contracts of depth.
      chainRow({ symbol: "THIN", strike: 500, delta: 0.55, bid: 8.0, ask: 8.1, mid: 8.05, bidSize: 2, askSize: 2, quoteTime: fresh() }),
      // Slightly further from target, but properly liquid.
      chainRow({ symbol: "GOOD", strike: 499, delta: 0.58, bid: 8.6, ask: 8.7, mid: 8.65, quoteTime: fresh() }),
      chainRow({ symbol: "SHORT", strike: 505, delta: 0.27, bid: 5.0, ask: 5.1, mid: 5.05, quoteTime: fresh() }),
    ];
    const candidate = selectDebitSpread({ rows, strategy: "bull_call_debit_spread", config, now: NOW });
    expect(candidate?.rejection).toBeNull();
    expect(candidate?.longLeg.symbol).toBe("GOOD");
  });

  it("prefers the pair with the best reward for risk among viable ones", () => {
    const rows = [
      chainRow({ symbol: "L1", strike: 500, delta: 0.55, bid: 8.0, ask: 8.1, mid: 8.05, quoteTime: fresh() }),
      chainRow({ symbol: "S_NARROW", strike: 503, delta: 0.27, bid: 6.0, ask: 6.1, mid: 6.05, quoteTime: fresh() }),
      chainRow({ symbol: "S_WIDE", strike: 510, delta: 0.28, bid: 5.6, ask: 5.7, mid: 5.65, quoteTime: fresh() }),
    ];
    const candidate = selectDebitSpread({ rows, strategy: "bull_call_debit_spread", config, now: NOW });
    expect(candidate?.rejection).toBeNull();
    // 510 strike: width 10, debit 2.50 -> 3.0:1. 503 strike: width 3, debit 2.10 -> 0.43:1.
    expect(candidate?.shortLeg.symbol).toBe("S_WIDE");
  });

  it("still reports a specific reason when no pair in the expiry qualifies", () => {
    const rows = callChain().map((row) => ({ ...row, bidSize: 1, askSize: 1 }));
    const candidate = selectDebitSpread({ rows, strategy: "bull_call_debit_spread", config, now: NOW });
    expect(candidate?.rejection).toMatch(/quote size/);
  });
});

describe("buildOrderIntent", () => {
  const candidate = selectDebitSpread({ rows: callChain(), strategy: "bull_call_debit_spread", config, now: NOW })!;

  it("sizes to the tightest binding limit", () => {
    // $3.10 debit = $310 per spread; the $250 per-trade cap allows zero contracts.
    const zero = buildOrderIntent({
      symbol: "SPY", strategy: "bull_call_debit_spread", candidate,
      equity: 100_000, dailyLossRemaining: 500, openInterest: { long: null, short: null },
      config, clientOrderId: "test",
    });
    expect(zero.qty).toBe(0);

    const sized = buildOrderIntent({
      symbol: "SPY", strategy: "bull_call_debit_spread", candidate,
      equity: 100_000, dailyLossRemaining: 5000,
      openInterest: { long: null, short: null },
      config: { ...config, maxLossPerTrade: 1000, maxRiskPercent: 0.05 } as VolGuardConfig,
      clientOrderId: "test",
    });
    expect(sized.qty).toBe(3);
    expect(sized.maxLoss).toBeCloseTo(930, 2);
  });

  it("is capped by the remaining daily loss budget", () => {
    const capped = buildOrderIntent({
      symbol: "SPY", strategy: "bull_call_debit_spread", candidate,
      equity: 100_000, dailyLossRemaining: 320,
      openInterest: { long: null, short: null },
      config: { ...config, maxLossPerTrade: 10_000, maxRiskPercent: 1 } as VolGuardConfig,
      clientOrderId: "test",
    });
    expect(capped.qty).toBe(1);
  });

  it("computes defined risk, reward and breakeven consistently", () => {
    const built = buildOrderIntent({
      symbol: "SPY", strategy: "bull_call_debit_spread", candidate,
      equity: 100_000, dailyLossRemaining: 5000,
      openInterest: { long: null, short: null },
      config: { ...config, maxLossPerTrade: 400, maxRiskPercent: 0.05 } as VolGuardConfig,
      clientOrderId: "test",
    });
    expect(built.qty).toBe(1);
    expect(built.maxLoss).toBeCloseTo(310, 2);
    expect(built.maxProfit).toBeCloseTo(190, 2);
    expect(built.rewardRisk).toBeCloseTo(190 / 310, 4);
    // Max loss plus max profit must equal the full width for a vertical.
    expect(built.maxLoss + built.maxProfit).toBeCloseTo(built.width * 100 * built.qty, 6);
    expect(built.breakeven).toBeCloseTo(503.1, 2);
  });

  it("produces an exit plan anchored on the entry debit", () => {
    const built = buildOrderIntent({
      symbol: "SPY", strategy: "bull_call_debit_spread", candidate,
      equity: 100_000, dailyLossRemaining: 5000,
      openInterest: { long: null, short: null },
      config: { ...config, maxLossPerTrade: 400, maxRiskPercent: 0.05 } as VolGuardConfig,
      clientOrderId: "test",
    });
    expect(built.exitPlan.takeProfitDebit).toBeCloseTo(4.05, 2);
    expect(built.exitPlan.stopLossDebit).toBeCloseTo(1.55, 2);
    expect(built.exitPlan.timeStopDte).toBe(7);
  });
});

describe("orderPayload", () => {
  it("emits a valid Alpaca multi-leg payload", () => {
    const payload = orderPayload(intent());
    expect(payload).toMatchObject({
      order_class: "mleg",
      qty: "1",
      type: "limit",
      time_in_force: "day",
      limit_price: "1.00",
    });
    const legs = payload.legs as Array<Record<string, string>>;
    expect(legs).toHaveLength(2);
    expect(legs[0]).toEqual({ symbol: "SPY260918C00100000", ratio_qty: "1", side: "buy", position_intent: "buy_to_open" });
    expect(legs[1].position_intent).toBe("sell_to_open");
  });

  it("carries the deterministic client order id used for idempotency", () => {
    expect(orderPayload(intent()).client_order_id).toBe("volguard-2026-08-19-spy-bull_call_debit_spread");
  });
});
