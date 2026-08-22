import { describe, expect, it } from "vitest";
import { closePayload, closeSpreadPayload, groupVerticals, reviewPositions, reviewSpreads } from "../positions";
import type { VolGuardConfig } from "../config";

const config = {
  timeStopDte: 7,
  stopLossPercent: 0.5,
  takeProfitPercent: 0.5,
  maxOpenPositions: 3,
} as VolGuardConfig;

function occ(strike: number, dte: number, type: "C" | "P" = "P") {
  const d = new Date(Date.now() + dte * 86_400_000);
  const yy = String(d.getUTCFullYear()).slice(2);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `SPY${yy}${mm}${dd}${type}${String(strike * 1000).padStart(8, "0")}`;
}

/** A credit spread at the time stop, so both legs are flagged to close. */
function creditSpreadAtTimeStop() {
  return [
    { symbol: occ(95, 3), asset_class: "us_option", qty: "1", cost_basis: "30",
      market_value: "6", unrealized_pl: "-24", unrealized_plpc: "-0.8" },
    { symbol: occ(100, 3), asset_class: "us_option", qty: "-1", cost_basis: "-180",
      market_value: "-160", unrealized_pl: "20", unrealized_plpc: "0.11" },
  ];
}

describe("closing a spread cannot leave a naked short", () => {
  it("emits ONE multi-leg order for a two-leg group, not one per leg", () => {
    const reviews = reviewSpreads(reviewPositions(creditSpreadAtTimeStop(), config), config);
    const groups = groupVerticals(reviews.filter((r) => r.action === "close"));

    // The whole point: two legs, one order. Two independent single-leg orders can be
    // half-filled, and the half that fills is the one that hedges.
    expect(groups).toHaveLength(1);
    const payload = closeSpreadPayload(groups[0], "exit-1");
    expect(payload.order_class).toBe("mleg");
    expect((payload.legs as unknown[])).toHaveLength(2);
  });

  it("closes the short leg by buying it back and the long leg by selling it", () => {
    const reviews = reviewSpreads(reviewPositions(creditSpreadAtTimeStop(), config), config);
    const [group] = groupVerticals(reviews.filter((r) => r.action === "close"));
    const legs = closeSpreadPayload(group, "exit-1").legs as Array<Record<string, string>>;

    const short = legs.find((l) => l.position_intent === "buy_to_close");
    const long = legs.find((l) => l.position_intent === "sell_to_close");
    expect(short, "the short leg must be bought back").toBeDefined();
    expect(long, "the long leg must be sold").toBeDefined();
    expect(short!.side).toBe("buy");
    expect(long!.side).toBe("sell");
  });

  it("still uses a single-leg order for a genuinely single-leg position", () => {
    const lone = [{
      symbol: occ(95, 3), asset_class: "us_option", qty: "1", cost_basis: "300",
      market_value: "100", unrealized_pl: "-200", unrealized_plpc: "-0.66",
    }];
    const reviews = reviewSpreads(reviewPositions(lone, config), config);
    const [group] = groupVerticals(reviews.filter((r) => r.action === "close"));
    expect(group.legs).toHaveLength(1);

    const payload = closePayload(group.legs[0], "exit-1");
    expect(payload.order_class).toBeUndefined();
    expect(payload.position_intent).toBe("sell_to_close");
  });

  it("never produces a payload that closes only the hedge", () => {
    // The specific catastrophe: an order that sells the long wing and leaves the short open.
    const reviews = reviewSpreads(reviewPositions(creditSpreadAtTimeStop(), config), config);
    const [group] = groupVerticals(reviews.filter((r) => r.action === "close"));
    const legs = closeSpreadPayload(group, "exit-1").legs as Array<Record<string, string>>;

    const closesShort = legs.some((l) => l.position_intent === "buy_to_close");
    const closesLong = legs.some((l) => l.position_intent === "sell_to_close");
    expect(closesShort && closesLong, "a close must cover both legs or neither").toBe(true);
  });

  it("groups by underlying, expiry and option type, so a condor closes as two orders", () => {
    const condor = [
      { symbol: occ(95, 3, "P"), asset_class: "us_option", qty: "1", cost_basis: "30", market_value: "5", unrealized_pl: "-25", unrealized_plpc: "-0.8" },
      { symbol: occ(100, 3, "P"), asset_class: "us_option", qty: "-1", cost_basis: "-180", market_value: "-160", unrealized_pl: "20", unrealized_plpc: "0.1" },
      { symbol: occ(115, 3, "C"), asset_class: "us_option", qty: "1", cost_basis: "30", market_value: "5", unrealized_pl: "-25", unrealized_plpc: "-0.8" },
      { symbol: occ(110, 3, "C"), asset_class: "us_option", qty: "-1", cost_basis: "-180", market_value: "-160", unrealized_pl: "20", unrealized_plpc: "0.1" },
    ];
    const reviews = reviewSpreads(reviewPositions(condor, config), config);
    const groups = groupVerticals(reviews.filter((r) => r.action === "close"));
    // Two independent verticals, two independent maximum losses, two orders — never one
    // four-leg order that could leave a mismatched pair.
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.legs).toHaveLength(2);
  });
});
