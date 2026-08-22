import type { VolGuardConfig } from "./config";
import type { PositionReview } from "./types";
import { parseOccSymbol } from "./volatility";

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Review every open option position against the exit plan. Alpaca reports positions leg
 * by leg, so a vertical appears as two rows; each leg is judged on its own P&L and on the
 * shared time stop, and the agent closes whatever it flags.
 */
export function reviewPositions(
  positions: Array<Record<string, unknown>>,
  config: VolGuardConfig,
  now = new Date(),
): PositionReview[] {
  const today = now.toISOString().slice(0, 10);

  return positions
    .filter((position) => String(position.asset_class ?? "") === "us_option" || parseOccSymbol(String(position.symbol ?? "")) !== null)
    .map((position) => {
      const symbol = String(position.symbol ?? "");
      const parsed = parseOccSymbol(symbol);
      const costBasis = Math.abs(num(position.cost_basis));
      const marketValue = num(position.market_value);
      const unrealizedPl = num(position.unrealized_pl);
      const unrealizedPlPct = num(position.unrealized_plpc);
      const daysToExpiry = parsed
        ? Math.round((Date.parse(`${parsed.expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
        : null;

      let action: PositionReview["action"] = "hold";
      let reason = "Inside the exit plan; holding.";

      if (daysToExpiry !== null && daysToExpiry <= config.timeStopDte) {
        action = "close";
        reason = `Time stop: ${daysToExpiry} days to expiry is at or inside the ${config.timeStopDte}-day limit, where gamma and pin risk dominate.`;
      } else if (unrealizedPlPct <= -config.stopLossPercent) {
        action = "close";
        reason = `Stop loss: position is ${(unrealizedPlPct * 100).toFixed(1)}% against entry, past the ${(config.stopLossPercent * 100).toFixed(0)}% limit.`;
      } else if (unrealizedPlPct >= config.takeProfitPercent) {
        action = "close";
        reason = `Take profit: position is ${(unrealizedPlPct * 100).toFixed(1)}% ahead, at or past the ${(config.takeProfitPercent * 100).toFixed(0)}% target.`;
      }

      return {
        symbol,
        // The old fallback chain put an expiry date in `underlying` when Alpaca omitted the
        // field, which then became part of the grouping key.
        underlying: String(position.underlying_symbol ?? symbol.replace(/\d{6}[CP]\d{8}$/, "") ?? symbol),
        qty: num(position.qty),
        side: String(position.side ?? "unknown"),
        costBasis,
        // Absolute cost basis loses the direction the credit arithmetic needs, so the signed
        // value is carried alongside rather than replacing it.
        costBasisSigned: num(position.cost_basis),
        strike: parsed?.strike ?? null,
        expiry: parsed?.expiry ?? null,
        type: parsed?.type ?? null,
        marketValue,
        unrealizedPl,
        unrealizedPlPct,
        daysToExpiry,
        action,
        reason,
      };
    });
}

/** The key that makes two legs one position. */
function groupKey(review: PositionReview): string {
  return `${review.underlying}|${review.expiry ?? "?"}|${review.type ?? "?"}`;
}

export interface SpreadGroup {
  key: string;
  legs: PositionReview[];
  /** True when the group holds a short leg, i.e. it is a credit structure. */
  hasShortLeg: boolean;
  /** Strike distance in dollars; null when it cannot be determined. */
  width: number | null;
  qty: number;
  groupPl: number;
  netMarketValue: number;
  /** Signed entry value: positive paid, negative collected. */
  entryValue: number;
  daysToExpiry: number | null;
}

/** Group legs into the positions they actually form. */
export function groupVerticals(reviews: PositionReview[]): SpreadGroup[] {
  const map = new Map<string, PositionReview[]>();
  for (const review of reviews) {
    const key = groupKey(review);
    const list = map.get(key);
    if (list) list.push(review);
    else map.set(key, [review]);
  }

  return [...map.entries()].map(([key, legs]) => {
    const strikes = legs.map((l) => l.strike).filter((v): v is number => v !== null);
    const dtes = legs.map((l) => l.daysToExpiry).filter((v): v is number => v !== null);
    return {
      key,
      legs,
      hasShortLeg: legs.some((l) => l.qty < 0),
      width: strikes.length >= 2 ? Math.abs(Math.max(...strikes) - Math.min(...strikes)) : null,
      qty: Math.max(...legs.map((l) => Math.abs(l.qty)), 0),
      groupPl: legs.reduce((sum, l) => sum + l.unrealizedPl, 0),
      netMarketValue: legs.reduce((sum, l) => sum + l.marketValue, 0),
      entryValue: legs.reduce((sum, l) => sum + l.costBasisSigned, 0),
      daysToExpiry: dtes.length > 0 ? Math.min(...dtes) : null,
    };
  });
}

/**
 * Count open *positions*, not legs. Alpaca reports a vertical as two rows, so counting rows
 * would let one spread consume two slots of `maxOpenPositions`. Option type is part of the
 * key: a call vertical and a put vertical on the same underlying and expiry are an iron
 * condor carrying two independent maximum losses, not one position.
 */
export function countOpenPositions(reviews: PositionReview[]): number {
  return new Set(reviews.map(groupKey)).size;
}

/**
 * Remaining defined risk across open positions, for the exposure gate.
 *
 * A long-premium group can only lose what is still at stake. A short vertical's worst
 * terminal value is minus the strike width, so what remains losable is the distance to that
 * floor — summing long legs alone would have counted a credit spread's ~$0.30 wing while the
 * real exposure was several hundred dollars, silently turning `portfolio_exposure` into
 * decoration.
 */
export function openRiskDollars(reviews: PositionReview[], maxLossPerTrade = Infinity): number {
  return groupVerticals(reviews).reduce((sum, group) => {
    if (!group.hasShortLeg) {
      const basis = group.legs
        .filter((l) => l.qty > 0)
        .reduce((s, l) => s + Math.max(0, l.costBasis + Math.min(0, l.unrealizedPl)), 0);
      return sum + basis;
    }
    if (group.width === null || group.qty === 0) {
      // Fail closed. An orphaned short leg after a partial close is the one case where
      // under-reporting risk is unacceptable, so it is charged the full per-trade limit.
      return sum + (Number.isFinite(maxLossPerTrade) ? maxLossPerTrade : 0);
    }
    return sum + Math.max(0, group.width * 100 * group.qty + group.netMarketValue);
  }, 0);
}

/**
 * Decide hold/close on the whole position, then stamp the decision onto every leg.
 *
 * This is the single most important function for credit spreads. Judging legs individually
 * means the cheap far wing of a credit spread — routinely down 50% on its own while the
 * spread is winning — gets closed by itself, leaving an unhedged short option with unbounded
 * risk. Both legs always share an action, and a test asserts it.
 *
 * Group P&L is the sum of Alpaca's per-leg `unrealized_pl`, which deliberately avoids
 * `unrealized_plpc`: its sign on a short leg depends on how Alpaca signs the cost basis, and
 * that is unverified.
 */
export function reviewSpreads(reviews: PositionReview[], config: VolGuardConfig): PositionReview[] {
  const decided: PositionReview[] = [];

  for (const group of groupVerticals(reviews)) {
    const entry = Math.abs(group.entryValue);
    const maxProfit = group.hasShortLeg
      ? entry
      : group.width !== null ? group.width * 100 * group.qty - entry : entry;
    const maxLoss = group.hasShortLeg
      ? group.width !== null ? group.width * 100 * group.qty - entry : entry
      : entry;

    // Signed progress toward the plan: +1 is the best case, -1 the worst.
    const denominator = group.groupPl >= 0 ? maxProfit : maxLoss;
    const progress = denominator > 0 ? group.groupPl / denominator : 0;

    let action: PositionReview["action"] = "hold";
    let reason = "Inside the exit plan; holding.";

    if (group.daysToExpiry !== null && group.daysToExpiry <= config.timeStopDte) {
      action = "close";
      // Kept for credit spreads too, tempting as it is to hold to expiry for the theta: the
      // final week is where gamma, pin risk and early assignment live, and assignment turns
      // a defined-risk spread into an unhedged stock position.
      reason = `Time stop: ${group.daysToExpiry} days to expiry is at or inside the ${config.timeStopDte}-day limit, where gamma, pin risk and assignment dominate.`;
    } else if (progress <= -config.stopLossPercent) {
      action = "close";
      reason = `Stop loss: the spread is ${(progress * 100).toFixed(1)}% toward its maximum loss, past the ${(config.stopLossPercent * 100).toFixed(0)}% limit.`;
    } else if (progress >= config.takeProfitPercent) {
      action = "close";
      reason = group.hasShortLeg
        ? `Take profit: ${(progress * 100).toFixed(1)}% of the credit has been kept, at or past the ${(config.takeProfitPercent * 100).toFixed(0)}% target.`
        : `Take profit: the spread is ${(progress * 100).toFixed(1)}% toward maximum profit, at or past the ${(config.takeProfitPercent * 100).toFixed(0)}% target.`;
    }

    for (const leg of group.legs) decided.push({ ...leg, action, reason });
  }

  return decided;
}

/**
 * Close a whole position in one multi-leg order, so the pair can never be broken.
 * `closePayload` remains for single-leg positions.
 */
export function closeSpreadPayload(group: SpreadGroup, clientOrderId: string): Record<string, unknown> {
  return {
    order_class: "mleg",
    qty: String(group.qty),
    type: "market",
    time_in_force: "day",
    client_order_id: clientOrderId,
    legs: group.legs.map((leg) => ({
      symbol: leg.symbol,
      ratio_qty: String(Math.max(1, Math.abs(leg.qty) / Math.max(1, group.qty))),
      side: leg.qty > 0 ? "sell" : "buy",
      position_intent: leg.qty > 0 ? "sell_to_close" : "buy_to_close",
    })),
  };
}

/** Single-leg closing order. Position intent mirrors the side actually held. */
export function closePayload(review: PositionReview, clientOrderId: string): Record<string, unknown> {
  const long = review.qty > 0;
  return {
    symbol: review.symbol,
    qty: String(Math.abs(review.qty)),
    side: long ? "sell" : "buy",
    position_intent: long ? "sell_to_close" : "buy_to_close",
    type: "market",
    time_in_force: "day",
    client_order_id: clientOrderId,
  };
}
