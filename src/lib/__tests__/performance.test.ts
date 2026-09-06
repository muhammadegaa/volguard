import { describe, expect, it } from "vitest";
import { dailyLossUsed, summarizePerformance } from "../performance";
import type { AgentRun } from "../types";
import { intent } from "./fixtures";

/**
 * Shaped from a real Alpaca FILL activity captured on 2026-08-19. Note what is NOT here:
 * no `position_intent`, and `order_id` is the *leg* order, not the parent mleg order.
 */
function fill(overrides: Record<string, unknown> = {}) {
  return {
    id: "20260819134349152::2d9b70b6",
    activity_type: "FILL",
    transaction_time: "2026-08-19T17:43:49.152173Z",
    type: "fill",
    price: "7.5",
    qty: "1",
    side: "buy",
    symbol: "SPY260918C00100000",
    leaves_qty: "0",
    order_id: "a91deb17-2efc-4eea-8656-1ead5a0ae92b",
    cum_qty: "1",
    order_status: "filled",
    ...overrides,
  };
}

const run = (overrides: Partial<AgentRun> = {}): AgentRun => ({
  id: "run-1",
  startedAt: "2026-08-19T17:43:00.000Z",
  finishedAt: "2026-08-19T17:43:50.000Z",
  mode: "paper", trigger: "manual", status: "TRADE_APPROVED", symbol: "SPY",
  scanned: [], observation: null, thesis: null, risk: null,
  orderIntent: intent(), alpacaOrderId: "6231e8dd-3198-4b55-973b-d98c1f483d52",
  positionReviews: [], exitOrderIds: [], decisions: [], durationMs: 100, message: "",
  ...overrides,
});

/** The exact opening pair from the live paper trade: buy 320C @7.50, sell_short 340C @1.85. */
const openingPair = [
  fill({ symbol: "SPY260918C00100000", side: "buy", price: "7.5" }),
  fill({ symbol: "SPY260918C00105000", side: "sell_short", price: "1.85", order_id: "9a4dddd1" }),
];

describe("summarizePerformance", () => {
  it("reports unavailable rather than zero when Alpaca has no history", () => {
    const summary = summarizePerformance({ history: null, fills: [], runs: [] });
    expect(summary.source).toBe("unavailable");
    expect(summary.equity).toBeNull();
    expect(summary.totalPl).toBeNull();
    expect(summary.realizedPl).toBeNull();
    expect(summary.note).toMatch(/no portfolio history/i);
  });

  it("computes total P&L and max drawdown from the Alpaca equity curve", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000, 102_000, 98_000, 101_000], base_value: 100_000 },
      fills: [], runs: [],
    });
    expect(summary.equity).toBe(101_000);
    expect(summary.totalPl).toBe(1_000);
    expect(summary.totalPlPct).toBeCloseTo(0.01, 6);
    expect(summary.maxDrawdownPct).toBeCloseTo(-0.0392, 3);
    expect(summary.source).toBe("alpaca_portfolio_history");
  });

  it("leaves realized P&L null while the spread is still open", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: openingPair,
      runs: [],
    });
    expect(summary.closedTrades).toBe(0);
    expect(summary.realizedPl).toBeNull();
    expect(summary.note).toMatch(/No option round trip has closed/);
  });

  it("realizes a winning long leg when its round trip closes", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: [
        fill({ side: "buy", price: "7.5" }),
        fill({ side: "sell", price: "9.0", transaction_time: "2026-08-25T14:00:00Z" }),
      ],
      runs: [],
    });
    expect(summary.closedTrades).toBe(1);
    expect(summary.wins).toBe(1);
    expect(summary.realizedPl).toBeCloseTo(150, 2); // (9.00 - 7.50) * 100
  });

  it("realizes a short leg closed with buy_to_cover", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: [
        fill({ side: "sell_short", price: "1.85" }),
        fill({ side: "buy_to_cover", price: "1.20", transaction_time: "2026-08-25T14:00:00Z" }),
      ],
      runs: [],
    });
    expect(summary.closedTrades).toBe(1);
    expect(summary.wins).toBe(1);
    expect(summary.realizedPl).toBeCloseTo(65, 2); // (1.85 - 1.20) * 100
  });

  it("realizes a losing round trip as a loss", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: [
        fill({ side: "buy", price: "7.5" }),
        fill({ side: "sell", price: "5.0", transaction_time: "2026-08-25T14:00:00Z" }),
      ],
      runs: [],
    });
    expect(summary.losses).toBe(1);
    expect(summary.wins).toBe(0);
    expect(summary.realizedPl).toBeCloseTo(-250, 2);
  });

  it("nets both legs of a closed spread into one result", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: [
        ...openingPair,
        fill({ symbol: "SPY260918C00100000", side: "sell", price: "9.0", transaction_time: "2026-08-25T14:00:00Z" }),
        fill({ symbol: "SPY260918C00105000", side: "buy_to_cover", price: "2.5", transaction_time: "2026-08-25T14:00:00Z" }),
      ],
      runs: [],
    });
    // Long +150, short -65 → +85 net across two closed round trips.
    expect(summary.closedTrades).toBe(2);
    expect(summary.realizedPl).toBeCloseTo(85, 2);
  });

  it("measures slippage by matching leg fills, not the parent mleg order id", () => {
    // Intent limit is $1.00; legs filled at 7.50 / 1.85 → net debit 5.65.
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: openingPair,
      runs: [run()],
    });
    expect(summary.slippage).toBeCloseTo(465, 2); // |5.65 - 1.00| * 100 * 1
  });

  it("leaves slippage null when the legs have not both filled", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: [openingPair[0]],
      runs: [run()],
    });
    expect(summary.slippage).toBeNull();
  });

  it("ignores fills that predate the run when matching slippage", () => {
    const stale = openingPair.map((f) => ({ ...f, transaction_time: "2020-01-01T00:00:00Z" }));
    expect(summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: stale, runs: [run()],
    }).slippage).toBeNull();
  });

  it("ignores equity fills when reconstructing option P&L", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: [
        fill({ symbol: "SPY", side: "buy", price: "500", qty: "10" }),
        fill({ symbol: "SPY", side: "sell", price: "510", qty: "10", transaction_time: "2026-08-25T14:00:00Z" }),
      ],
      runs: [],
    });
    expect(summary.closedTrades).toBe(0);
    expect(summary.realizedPl).toBeNull();
  });

  it("handles a partial scale-out that does not flatten the position", () => {
    const summary = summarizePerformance({
      history: { equity: [100_000], base_value: 100_000 },
      fills: [
        fill({ side: "buy", price: "7.5", qty: "2" }),
        fill({ side: "sell", price: "9.0", qty: "1", transaction_time: "2026-08-25T14:00:00Z" }),
      ],
      runs: [],
    });
    expect(summary.closedTrades).toBe(0);
    expect(summary.realizedPl).toBeNull();
  });
});

describe("dailyLossUsed", () => {
  it("reports the drawdown from the previous close as a positive number", () => {
    expect(dailyLossUsed({ equity: "99976.95", last_equity: "100000" })).toBeCloseTo(23.05, 2);
  });

  it("is zero on a profitable day, so gains never bank extra risk budget", () => {
    expect(dailyLossUsed({ equity: "101000", last_equity: "100000" })).toBe(0);
  });

  it("is zero on a flat day", () => {
    expect(dailyLossUsed({ equity: "100000", last_equity: "100000" })).toBe(0);
  });

  it("is zero rather than NaN when Alpaca omits the fields", () => {
    expect(dailyLossUsed({})).toBe(0);
    expect(dailyLossUsed({ equity: "100000" })).toBe(0);
    expect(dailyLossUsed({ equity: "abc", last_equity: "100000" })).toBe(0);
  });
});
