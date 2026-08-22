import { describe, expect, it } from "vitest";
import { closePayload, countOpenPositions, openRiskDollars, reviewPositions } from "../positions";
import type { VolGuardConfig } from "../config";

const config = { takeProfitPercent: 0.5, stopLossPercent: 0.5, timeStopDte: 7 } as VolGuardConfig;
const NOW = new Date("2026-08-19T16:00:00Z");

function position(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "SPY260918C00500000",
    asset_class: "us_option",
    qty: "1",
    side: "long",
    cost_basis: "310",
    market_value: "330",
    unrealized_pl: "20",
    unrealized_plpc: "0.0645",
    underlying_symbol: "SPY",
    ...overrides,
  };
}

describe("reviewPositions", () => {
  it("holds a position that is inside the exit plan", () => {
    const [review] = reviewPositions([position()], config, NOW);
    expect(review.action).toBe("hold");
  });

  it("closes on the take-profit target", () => {
    const [review] = reviewPositions([position({ unrealized_plpc: "0.62" })], config, NOW);
    expect(review.action).toBe("close");
    expect(review.reason).toMatch(/Take profit/);
  });

  it("closes on the stop loss", () => {
    const [review] = reviewPositions([position({ unrealized_plpc: "-0.55" })], config, NOW);
    expect(review.action).toBe("close");
    expect(review.reason).toMatch(/Stop loss/);
  });

  it("closes on the time stop before expiry gamma dominates", () => {
    const [review] = reviewPositions([position({ symbol: "SPY260822C00500000" })], config, NOW);
    expect(review.daysToExpiry).toBe(3);
    expect(review.action).toBe("close");
    expect(review.reason).toMatch(/Time stop/);
  });

  it("prioritises the time stop over an otherwise healthy P&L", () => {
    const [review] = reviewPositions([position({ symbol: "SPY260822C00500000", unrealized_plpc: "0.1" })], config, NOW);
    expect(review.reason).toMatch(/Time stop/);
  });

  it("ignores equity positions", () => {
    expect(reviewPositions([{ symbol: "SPY", asset_class: "us_equity", qty: "10" }], config, NOW)).toHaveLength(0);
  });

  it("parses days to expiry from the contract symbol", () => {
    const [review] = reviewPositions([position()], config, NOW);
    expect(review.daysToExpiry).toBe(30);
  });
});

describe("openRiskDollars", () => {
  it("sums remaining risk across open long legs", () => {
    const reviews = reviewPositions([position(), position({ symbol: "SPY260918C00505000", cost_basis: "150" })], config, NOW);
    expect(openRiskDollars(reviews)).toBeCloseTo(460, 2);
  });

  it("reduces exposure by an unrealized loss already taken", () => {
    const reviews = reviewPositions([position({ cost_basis: "310", unrealized_pl: "-100" })], config, NOW);
    expect(openRiskDollars(reviews)).toBeCloseTo(210, 2);
  });
});

describe("countOpenPositions", () => {
  it("counts a two-leg spread as ONE position, not two", () => {
    const reviews = reviewPositions([
      position({ symbol: "SPY260918C00500000" }),
      position({ symbol: "SPY260918C00505000", qty: "-1", side: "short" }),
    ], config, NOW);
    expect(reviews).toHaveLength(2);
    expect(countOpenPositions(reviews)).toBe(1);
  });

  it("counts different expiries on the same underlying separately", () => {
    const reviews = reviewPositions([
      position({ symbol: "SPY260918C00500000" }),
      position({ symbol: "SPY261016C00500000" }),
    ], config, NOW);
    expect(countOpenPositions(reviews)).toBe(2);
  });

  it("counts different underlyings separately", () => {
    const reviews = reviewPositions([
      position({ symbol: "SPY260918C00500000", underlying_symbol: "SPY" }),
      position({ symbol: "AAPL260918C00300000", underlying_symbol: "AAPL" }),
    ], config, NOW);
    expect(countOpenPositions(reviews)).toBe(2);
  });

  it("is zero with no positions", () => {
    expect(countOpenPositions([])).toBe(0);
  });
});

describe("closePayload", () => {
  it("sells to close a long option leg", () => {
    const [review] = reviewPositions([position()], config, NOW);
    expect(closePayload(review, "exit-1")).toMatchObject({
      symbol: "SPY260918C00500000",
      qty: "1",
      side: "sell",
      position_intent: "sell_to_close",
      type: "market",
      time_in_force: "day",
      client_order_id: "exit-1",
    });
  });

  it("buys to close a short option leg", () => {
    const [review] = reviewPositions([position({ qty: "-1", side: "short" })], config, NOW);
    expect(closePayload(review, "exit-2")).toMatchObject({ side: "buy", position_intent: "buy_to_close", qty: "1" });
  });
});
