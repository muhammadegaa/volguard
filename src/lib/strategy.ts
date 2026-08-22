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
 * The variance risk premium (ATM implied vol minus a horizon-matched forecast of realized
 * vol) measures what the option market charges for movement against what the underlying is
 * expected to deliver over the life of the option being priced.
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

  if (vol.atmImpliedVol === null || vol.forecastVol === null || vol.varianceRiskPremium === null) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: ["Implied or realized volatility is unavailable, so the premium cannot be priced against delivery."],
      verdict: "no volatility data",
    };
  }

  const vrp = vol.varianceRiskPremium;
  // This sentence is written to the audit ledger, so the arithmetic in it has to be the
  // arithmetic that was actually performed. It previously named the trailing bipower
  // estimate while quoting a premium computed against the forecast — a false identity,
  // recorded on every run.
  const basis = vol.forecastSource === "har"
    ? `${vol.forecastHorizonDays}-day forecast realized`
    : `${vol.forecastHorizonDays}-day trailing realized (forecast unavailable)`;
  rationale.push(
    `ATM IV ${(vol.atmImpliedVol * 100).toFixed(1)}% minus ${basis} ${(vol.forecastVol * 100).toFixed(1)}% gives a variance risk premium of ${(vrp * 100).toFixed(1)} vol points.`,
  );
  if (vol.trailingVarianceRiskPremium !== null) {
    rationale.push(
      `For comparison, the pre-forecast basis (ATM IV minus trailing 20-day jump-robust realized ${((vol.bipowerVol20 ?? 0) * 100).toFixed(1)}%) would have read ${(vol.trailingVarianceRiskPremium * 100).toFixed(1)} vol points.`,
    );
  }

  // ── Regime ───────────────────────────────────────────────────────────────
  // Classify first, gate second. The old ladder applied one set of thresholds to a single
  // strategy; selling premium is a different risk and needs its own, stricter set.
  const selling = config.sellPremiumEnabled && vrp >= config.minSellVrp;
  const buying = vrp <= config.maxEntryVrp;

  if (!buying && !selling) {
    // The dead band between the two thresholds is deliberate. The premium carries a couple
    // of vol points of measurement error, and an agent that flips between buying and selling
    // on consecutive runs in the same regime is not being decisive, it is reading noise.
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: [
        ...rationale,
        config.sellPremiumEnabled
          ? `The premium is ${(vrp * 100).toFixed(1)} vol points: above the ${(config.maxEntryVrp * 100).toFixed(1)} ceiling for buying and below the ${(config.minSellVrp * 100).toFixed(1)} floor for selling. Inside that band the edge is smaller than the measurement error.`
          : `Options are rich: the premium is ${(vrp * 100).toFixed(1)} vol points above expected movement, over the ${(config.maxEntryVrp * 100).toFixed(1)} entry ceiling. Premium selling is disabled, so VolGuard stands aside rather than paying up.`,
      ],
      verdict: config.sellPremiumEnabled ? `no VRP edge (+${(vrp * 100).toFixed(1)}v)` : `IV rich (+${(vrp * 100).toFixed(1)}v)`,
    };
  }

  // ── Gates, by regime ─────────────────────────────────────────────────────
  const jumpLimit = selling ? config.maxSellJumpFraction : config.maxJumpFraction;
  if (vol.jumpFraction !== null && vol.jumpFraction > jumpLimit) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: [
        ...rationale,
        `${(vol.jumpFraction * 100).toFixed(0)}% of the last 20 days of realized variance came from jumps, above the ${(jumpLimit * 100).toFixed(0)}% limit${selling ? " for selling premium" : ""}. Raw realized vol reads ${(((vol.realizedVol20 ?? 0)) * 100).toFixed(1)}%, but that move has already happened and is not a forecast.`,
      ],
      verdict: `jump-contaminated (${(vol.jumpFraction * 100).toFixed(0)}%)`,
    };
  }

  // Selling into a known catalyst is categorically worse than buying into one: the rich
  // implied vol being sold IS the compensation for that catalyst, and a binary event is
  // precisely what breaches a short strike. The threshold is therefore far tighter, and
  // severity blocks on its own regardless of score.
  const eventLimit = selling ? config.maxSellEventScore : config.maxEventScore;
  const severityBlocks = selling && (observation.event.severity === "elevated" || observation.event.severity === "high");
  if (observation.event.score >= eventLimit || severityBlocks) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: [
        ...rationale,
        severityBlocks
          ? `Event severity is ${observation.event.severity}; premium is not sold into a known catalyst at any score.`
          : `Event risk scores ${observation.event.score}/100 (${observation.event.severity}), at or above the ${eventLimit} abstain threshold${selling ? " for selling premium" : ""}. Premium is compensation for a known catalyst, not a mispricing.`,
        ...observation.event.drivers.slice(0, 3),
      ],
      verdict: `event risk ${observation.event.score}`,
    };
  }

  // Backwardation means the front expiry is pricing more movement than the back: the market
  // expects something soon that the news taxonomy may not have named. For a seller that is
  // the single most dangerous signature — the expiry being sold is the one being bid — so
  // any backwardation at all blocks a sale.
  const slopeFloor = selling ? config.sellMinTermSlope : -0.02;
  if (vol.termSlope !== null && vol.termSlope < slopeFloor) {
    return {
      strategy: "no_trade",
      direction: "neutral",
      confidence: 0,
      rationale: [
        ...rationale,
        `Term structure is in backwardation (${(vol.termSlope * 100).toFixed(1)} vol points front-to-back), below the ${(slopeFloor * 100).toFixed(1)} floor${selling ? " for selling premium" : ""}. The curve is pricing a near-dated shock that the headline scan did not identify.`,
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
  // Buying, express the view directly. Selling, sell the side you believe it does NOT go:
  // bullish sells puts below spot, bearish sells calls above it.
  const strategy: StrategyKind = selling
    ? (bearish ? "bear_call_credit_spread" : "bull_put_credit_spread")
    : (bearish ? "bear_put_debit_spread" : "bull_call_debit_spread");

  rationale.push(
    selling
      ? `Spot is ${(trend * 100).toFixed(2)}% versus its 20-day average and 25-delta skew is ${(skew * 100).toFixed(1)} vol points, so the premium is sold on the ${bearish ? "call" : "put"} side — the side the underlying is less likely to reach.`
      : `Spot is ${(trend * 100).toFixed(2)}% versus its 20-day average and 25-delta skew is ${(skew * 100).toFixed(1)} vol points, so the cheap convexity is expressed on the ${bearish ? "put" : "call"} side.`,
  );
  if (vol.realizedVolRank !== null) {
    rationale.push(`Realized-vol rank is ${(vol.realizedVolRank * 100).toFixed(0)}% of its trailing one-year range.`);
  }
  if (vol.impliedVolRank !== null) {
    rationale.push(`Implied-vol rank is ${(vol.impliedVolRank * 100).toFixed(0)}% across ${vol.ivSamples} VolGuard observations.`);
  }

  // Confidence scales with how far below the ceiling the premium sits, capped so the
  // agent never presents a single signal as near-certainty.
  const edge = Math.min(1, Math.abs(vrp - (selling ? config.minSellVrp : config.maxEntryVrp)) / 0.06);
  const eventDrag = 1 - observation.event.score / (config.maxEventScore * 2);
  const confidence = Math.max(0.1, Math.min(0.85, 0.35 + edge * 0.45 * eventDrag));

  return {
    strategy,
    direction,
    confidence: Number(confidence.toFixed(2)),
    rationale,
    // The verdict grammar is parsed by regex in explain.ts. A new shape must be added there
    // ABOVE the legacy `IV rich` branch, which is unanchored and would otherwise swallow it
    // and report a trade as a skip.
    verdict: selling
      ? `IV rich (+${(vrp * 100).toFixed(1)}v) → ${bearish ? "call" : "put"} credit spread`
      : `IV cheap (${(vrp * 100).toFixed(1)}v) → ${bearish ? "put" : "call"} debit spread`,
  };
}
