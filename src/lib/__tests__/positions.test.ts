import { describe, expect, it } from "vitest";
import { closePayload, closeSpreadPayload, countOpenPositions, groupVerticals, openRiskDollars, reviewPositions, reviewSpreads } from "../positions";
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

describe("a credit spread must never be half-closed", () => {
  /** A credit spread: short the near-the-money 100 put, long the 95 wing. */
  function creditLegs(overrides: { shortPl?: number; longPl?: number; dte?: number } = {}) {
    const { shortPl = 20, longPl = -24, dte = 30 } = overrides;
    const expiry = new Date(Date.now() + dte * 86_400_000).toISOString().slice(0, 10);
    const occ = (strike: number) => {
      const [y, m, d] = expiry.split("-");
      return `SPY${y.slice(2)}${m}${d}P${String(strike * 1000).padStart(8, "0")}`;
    };
    return [
      // The far wing: cheap, and routinely down heavily on its own while the spread wins.
      { symbol: occ(95), asset_class: "us_option", qty: "1", cost_basis: "30",
        market_value: String(30 + longPl), unrealized_pl: String(longPl), unrealized_plpc: String(longPl / 30) },
      { symbol: occ(100), asset_class: "us_option", qty: "-1", cost_basis: "-180",
        market_value: String(-180 + shortPl), unrealized_pl: String(shortPl), unrealized_plpc: String(shortPl / 180) },
    ];
  }

  it("does not close the wing alone when it is down 80% and the spread is winning", () => {
    // The exact scenario that would leave an unhedged short option.
    const raw = reviewPositions(creditLegs({ longPl: -24, shortPl: 20 }), config);
    const decided = reviewSpreads(raw, config);

    expect(decided).toHaveLength(2);
    const actions = new Set(decided.map((r) => r.action));
    expect(actions.size, "both legs must share one decision").toBe(1);
    expect(decided[0].action).toBe("hold");
  });

  it("closes both legs together, or neither, whatever the individual legs are doing", () => {
    for (const scenario of [
      { longPl: -29, shortPl: 5 },
      { longPl: 40, shortPl: -150 },
      { longPl: -10, shortPl: 140 },
    ]) {
      const decided = reviewSpreads(reviewPositions(creditLegs(scenario), config), config);
      expect(new Set(decided.map((r) => r.action)).size, JSON.stringify(scenario)).toBe(1);
    }
  });

  it("takes profit once most of the credit has been kept", () => {
    // Collected $150 net; $120 of it banked is 80% of maximum profit.
    const decided = reviewSpreads(reviewPositions(creditLegs({ shortPl: 130, longPl: -10 }), config), config);
    expect(decided[0].action).toBe("close");
    expect(decided[0].reason).toMatch(/credit has been kept|maximum profit/i);
  });

  it("applies the time stop to the whole position", () => {
    const decided = reviewSpreads(reviewPositions(creditLegs({ dte: 3 }), config), config);
    expect(decided.every((r) => r.action === "close")).toBe(true);
    expect(decided[0].reason).toMatch(/Time stop/);
  });

  it("closes a spread in one multi-leg order so the pair cannot be broken", () => {
    const groups = groupVerticals(reviewPositions(creditLegs(), config));
    expect(groups).toHaveLength(1);
    const payload = closeSpreadPayload(groups[0], "exit-1");
    expect(payload.order_class).toBe("mleg");
    const legs = payload.legs as Array<Record<string, string>>;
    expect(legs.map((l) => l.position_intent).sort()).toEqual(["buy_to_close", "sell_to_close"]);
  });
});

describe("exposure accounting with a short leg present", () => {
  function shortVertical() {
    const expiry = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const [y, m, d] = expiry.split("-");
    const occ = (k: number) => `SPY${y.slice(2)}${m}${d}P${String(k * 1000).padStart(8, "0")}`;
    return [
      { symbol: occ(95), asset_class: "us_option", qty: "1", cost_basis: "30", market_value: "25", unrealized_pl: "-5", unrealized_plpc: "-0.16" },
      { symbol: occ(100), asset_class: "us_option", qty: "-1", cost_basis: "-180", market_value: "-175", unrealized_pl: "5", unrealized_plpc: "0.03" },
    ];
  }

  it("counts what is still losable, not just the long leg's cost basis", () => {
    const reviews = reviewPositions(shortVertical(), config);
    // The long wing alone is $25. Real remaining risk is the $500 width less the $150 net
    // market value still owed — an order of magnitude more.
    const risk = openRiskDollars(reviews, 1000);
    expect(risk).toBeGreaterThan(300);
    expect(risk).toBeLessThanOrEqual(500);
  });

  it("fails closed on an orphaned short leg whose width cannot be determined", () => {
    const [, short] = shortVertical();
    const risk = openRiskDollars(reviewPositions([short], config), 1000);
    // Under-reporting an unhedged short is the one outcome that is not acceptable.
    expect(risk).toBe(1000);
  });

  it("counts a call vertical and a put vertical on one expiry as two positions", () => {
    const expiry = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const [y, m, d] = expiry.split("-");
    const mk = (t: "C" | "P", k: number) => ({
      symbol: `SPY${y.slice(2)}${m}${d}${t}${String(k * 1000).padStart(8, "0")}`,
      asset_class: "us_option", qty: "1", cost_basis: "100", market_value: "100",
      unrealized_pl: "0", unrealized_plpc: "0",
    });
    // An accidental iron condor carries two independent maximum losses.
    expect(countOpenPositions(reviewPositions([mk("C", 105), mk("C", 110), mk("P", 95), mk("P", 90)], config))).toBe(2);
  });
});
