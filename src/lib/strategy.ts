import type { VolGuardConfig } from "./config";
import type { MarketObservation, StrategyKind } from "./types";

export interface StrategyVerdict {
  strategy: StrategyKind;
  direction: "bullish" | "bearish" | "neutral";
  /** 0..1, derived from how far the signals clear their thresholds. */
  confidence: number;
  rationale: string[];
  /** Short sentence for the scan table. */
  verdict: string;
}

/**
 * VolGuard's edge is not direction, it is the price of movement.
 *
 * The variance risk premium (ATM implied vol minus 20-day realized vol) measures what the
 * option market charges for movement against what the underlying has actually delivered.
 * When that premium is negative, optionality is cheap and a long-premium debit spread is
 * paying below fair value for convexity. When it is positive, options are expensive and
 * the honest action is to stand aside: VolGuard only ever buys premium, so a rich tape is
 * a reason to abstain rather than a reason to flip into selling risk it cannot define.
 *
 * The event gate exists because implied vol is often expensive for a good reason. A known
 * binary catalyst inside the holding window means the premium is compensation, not
 * mispricing, so the setup is skipped regardless of how attractive the premium looks.
 */
export function decideStrategy(observation: MarketObservation, config: VolGuardConfig): StrategyVerdict {
  const vol = observation.volatility;
  const rationale: string[] = [];

  if (vol.atmImpliedVol === null || vol.bipowerVol20 === null || vol.varianceRiskPremium === null) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: ["Implied or realized volatility is unavailable, so the premium cannot be priced against delivery."],
      verdict: "no volatility data",
    };
  }

  const vrp = vol.varianceRiskPremium;
  rationale.push(
    `ATM IV ${(vol.atmImpliedVol * 100).toFixed(1)}% vs 20d jump-robust realized ${(vol.bipowerVol20 * 100).toFixed(1)}% gives a variance risk premium of ${(vrp * 100).toFixed(1)} vol points.`,
  );

  // A trailing gap makes raw realized volatility enormous while saying nothing about what
  // the underlying will deliver from here. Refuse to read that as cheap optionality.
  if (vol.jumpFraction !== null && vol.jumpFraction > config.maxJumpFraction) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: [
        ...rationale,
        `${(vol.jumpFraction * 100).toFixed(0)}% of the last 20 days of realized variance came from jumps, above the ${(config.maxJumpFraction * 100).toFixed(0)}% limit. Raw realized vol reads ${(((vol.realizedVol20 ?? 0)) * 100).toFixed(1)}%, but that move has already happened and is not a forecast.`,
      ],
      verdict: `jump-contaminated (${(vol.jumpFraction * 100).toFixed(0)}%)`,
    };
  }

  if (observation.event.score >= config.maxEventScore) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: [
        ...rationale,
        `Event risk scores ${observation.event.score}/100 (${observation.event.severity}), at or above the ${config.maxEventScore} abstain threshold. Premium is compensation for a known catalyst, not a mispricing.`,
        ...observation.event.drivers.slice(0, 3),
      ],
      verdict: `event risk ${observation.event.score}`,
    };
  }

  if (vrp > config.maxEntryVrp) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: [
        ...rationale,
        `Options are rich: the premium is ${(vrp * 100).toFixed(1)} vol points above delivered movement, over the ${(config.maxEntryVrp * 100).toFixed(1)} entry ceiling. VolGuard buys premium only, so it stands aside rather than paying up.`,
      ],
      verdict: `IV rich (+${(vrp * 100).toFixed(1)}v)`,
    };
  }

  // Backwardation means the front expiry is pricing more movement than the back: the
  // market expects something soon that the news taxonomy may not have named.
  if (vol.termSlope !== null && vol.termSlope < -0.02) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: [
        ...rationale,
        `Term structure is in backwardation (${(vol.termSlope * 100).toFixed(1)} vol points front-to-back). The curve is pricing a near-dated shock that the headline scan did not identify.`,
      ],
      verdict: "backwardation",
    };
  }

  // Direction: trend against the 20-day mean, confirmed by skew. A bid for downside
  // protection alongside a weak tape argues for the put side.
  const trend = observation.trend ?? 0;
  const skew = vol.skew25 ?? 0;
  const bearish = trend < -0.005 || (skew > 0.03 && trend < 0.005);
  const direction: StrategyVerdict["direction"] = bearish ? "bearish" : "bullish";
  const strategy: StrategyKind = bearish ? "bear_put_debit_spread" : "bull_call_debit_spread";

  rationale.push(
    `Spot is ${(trend * 100).toFixed(2)}% versus its 20-day average and 25-delta skew is ${(skew * 100).toFixed(1)} vol points, so the cheap convexity is expressed on the ${bearish ? "put" : "call"} side.`,
  );
  if (vol.realizedVolRank !== null) {
    rationale.push(`Realized-vol rank is ${(vol.realizedVolRank * 100).toFixed(0)}% of its trailing one-year range.`);
  }
  if (vol.impliedVolRank !== null) {
    rationale.push(`Implied-vol rank is ${(vol.impliedVolRank * 100).toFixed(0)}% across ${vol.ivSamples} VolGuard observations.`);
  }

  // Confidence scales with how far below the ceiling the premium sits, capped so the
  // agent never presents a single signal as near-certainty.
  const edge = Math.min(1, Math.abs(vrp - config.maxEntryVrp) / 0.06);
  const eventDrag = 1 - observation.event.score / (config.maxEventScore * 2);
  const confidence = Math.max(0.1, Math.min(0.85, 0.35 + edge * 0.45 * eventDrag));

  return {
    strategy,
    direction,
    confidence: Number(confidence.toFixed(2)),
    rationale,
    verdict: `IV cheap (${(vrp * 100).toFixed(1)}v) → ${bearish ? "put" : "call"} debit spread`,
  };
}
