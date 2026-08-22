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
        underlying: String(position.underlying_symbol ?? parsed?.expiry ?? symbol.slice(0, 3)),
        qty: num(position.qty),
        side: String(position.side ?? "unknown"),
        costBasis,
        marketValue,
        unrealizedPl,
        unrealizedPlPct,
        daysToExpiry,
        action,
        reason,
      };
    });
}

/**
 * Count open *positions*, not legs. Alpaca reports a vertical spread as two rows, so
 * counting rows would let a single spread consume two slots of `maxOpenPositions`.
 * One underlying + expiry is one position.
 */
export function countOpenPositions(reviews: PositionReview[]): number {
  const groups = new Set<string>();
  for (const review of reviews) {
    const parsed = parseOccSymbol(review.symbol);
    groups.add(`${review.underlying}|${parsed?.expiry ?? "?"}`);
  }
  return groups.size;
}

/** Remaining defined risk across open long option legs, used for the exposure gate. */
export function openRiskDollars(reviews: PositionReview[]): number {
  return reviews
    .filter((review) => review.qty > 0)
    .reduce((sum, review) => sum + Math.max(0, review.costBasis + Math.min(0, review.unrealizedPl)), 0);
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
