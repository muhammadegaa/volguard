import type { AgentRun, DecisionStatus, EventSeverity } from "./types";

/**
 * The plain-language layer.
 *
 * VolGuard's analysis is genuinely technical, and dumbing it down would make it useless to
 * anyone who can judge it. So nothing here removes a number: every function turns a term of
 * art into a sentence a first-time visitor can act on, and the original value stays on screen
 * beside it. This is progressive disclosure, not a simplified product.
 *
 * It lives in `lib` rather than in the component tree because it is pure, and because a
 * wrong explanation is a correctness bug — it deserves tests like any other logic.
 */

export type Tone = "good" | "warn" | "bad" | "neutral";

export interface Explanation {
  /** One sentence, no jargon, understandable with zero options background. */
  headline: string;
  /** Why it matters, or what happens next. */
  detail: string;
  tone: Tone;
}

// ── Glossary ────────────────────────────────────────────────────────────────

export interface GlossaryEntry {
  /** How the term is written out in full. */
  term: string;
  /** One plain sentence. */
  plain: string;
  /** Why VolGuard cares about it. */
  why: string;
}

export const GLOSSARY = {
  "implied-volatility": {
    term: "Implied volatility (IV)",
    plain: "How much movement the options market is charging for, expressed as a yearly percentage.",
    why: "This is the price of movement. VolGuard wants to buy it when it is low.",
  },
  "realized-volatility": {
    term: "Realized volatility (RV)",
    plain: "How much the stock has actually moved recently, on the same yearly percentage scale.",
    why: "It is the reality check against what options cost. Charging 30% for a stock that delivers 20% is expensive.",
  },
  "bipower": {
    term: "Jump-robust realized volatility",
    plain: "Realized volatility recalculated so that one huge one-day gap cannot dominate the answer.",
    why: "A stock that gapped 15% on earnings looks wildly volatile by the plain measure, even if it has been calm since. VolGuard prices against this instead.",
  },
  "variance-risk-premium": {
    term: "Variance risk premium (VRP)",
    plain: "Implied volatility minus realized volatility — what options charge, minus what the stock delivers.",
    why: "Negative means options are cheap relative to real movement, which is the only condition VolGuard buys in. It is the entire strategy in one number.",
  },
  "jump-fraction": {
    term: "Variance from jumps",
    plain: "The share of recent movement that came from sudden gaps rather than ordinary day-to-day drift.",
    why: "A high number means the volatility reading is backward-looking noise from an event that already happened. Above 35%, VolGuard refuses to trade it.",
  },
  "term-slope": {
    term: "Term structure slope",
    plain: "The difference between what near-dated and longer-dated options charge for movement.",
    why: "When near-dated costs more (backwardation), the market is bracing for something soon that the news scan may not have named.",
  },
  "skew": {
    term: "25-delta skew",
    plain: "How much more expensive downside protection is than equivalent upside.",
    why: "Heavy demand for downside puts alongside a weak price is evidence to express the trade on the put side.",
  },
  "delta": {
    term: "Delta (Δ)",
    plain: "Roughly how much the option moves for each $1 the stock moves, from 0 to 1.",
    why: "It doubles as an approximate chance of finishing in the money. VolGuard targets ~0.55 for the leg it buys and ~0.27 for the leg it sells.",
  },
  "dte": {
    term: "Days to expiry (DTE)",
    plain: "How many days until the option contract expires and settles.",
    why: "VolGuard targets about 30 days: long enough for the thesis to play out, short enough that the position is not open forever.",
  },
  "debit-spread": {
    term: "Defined-risk debit spread",
    plain: "Buying one option and selling another further away, on the same stock and expiry, for a single net cost.",
    why: "The most you can lose is what you paid, known before the order is sent. VolGuard trades nothing else — no naked options, no unlimited risk.",
  },
  "net-debit": {
    term: "Net debit",
    plain: "The total price paid per spread, after the option sold offsets part of the option bought.",
    why: "This is the cash at risk. Multiply by 100 (one contract covers 100 shares) and by the number of contracts.",
  },
  "max-loss": {
    term: "Maximum loss",
    plain: "The worst possible outcome of this position, in dollars.",
    why: "For a debit spread it equals the net debit paid. It cannot lose more, which is what makes it safe to automate.",
  },
  "max-profit": {
    term: "Maximum profit",
    plain: "The best possible outcome, reached if the stock finishes past the strike that was sold.",
    why: "Selling the further option caps the upside. That cap is the price of making the downside knowable.",
  },
  "breakeven": {
    term: "Breakeven",
    plain: "The stock price at expiry where the position makes exactly nothing — no profit, no loss.",
    why: "Above it (for a call spread), the trade makes money. It shows how far the stock has to move to be worth the premium.",
  },
  "reward-risk": {
    term: "Reward-to-risk",
    plain: "Maximum profit divided by maximum loss.",
    why: "1.5 means risking $1 to make $1.50. VolGuard flags anything below 0.4 as poor value, though it does not block on it.",
  },
  "bid-ask-spread": {
    term: "Bid–ask spread",
    plain: "The gap between what buyers offer and what sellers ask.",
    why: "You pay this gap on entry and again on exit. A wide gap can quietly cost more than the edge is worth, so VolGuard blocks above 8%.",
  },
  "quote-age": {
    term: "Quote age",
    plain: "How many seconds old the last price update is.",
    why: "Trading on a stale price is trading on fiction. Anything older than 90 seconds is blocked.",
  },
  "open-interest": {
    term: "Open interest",
    plain: "How many contracts of this exact option are currently held by traders.",
    why: "Low open interest means few people trade it, so getting out later may be hard or expensive.",
  },
  "event-risk": {
    term: "Event risk",
    plain: "A 0–100 score for whether a known catalyst — earnings, a product launch, a regulator — lands inside the holding window.",
    why: "Expensive options before earnings are not a mistake to exploit; they are compensation for a real coin flip. VolGuard stands aside at 60 or above.",
  },
  "iv-rank": {
    term: "IV / RV rank",
    plain: "Where today's volatility sits inside its own trailing range, from 0% (lowest ever seen) to 100% (highest).",
    why: "Context. A 25% reading means something very different for a utility than for a biotech.",
  },
  "paper-trading": {
    term: "Paper trading",
    plain: "A full-featured simulated brokerage account with live market data and zero real money.",
    why: "Every order here is paper. The app refuses to start against a live trading endpoint, and that refusal is enforced in code and tested.",
  },
  "dry-run": {
    term: "Dry run",
    plain: "A complete analysis — real data, real prices, real risk checks — that stops just before sending an order.",
    why: "It is the default mode. You see exactly what the agent would have done, without anything being placed.",
  },
  "drawdown": {
    term: "Maximum drawdown",
    plain: "The largest peak-to-trough fall in account value so far.",
    why: "It is the honest measure of how bad it got along the way, which an ending balance hides.",
  },
  "slippage": {
    term: "Slippage",
    plain: "The difference between the price the agent intended and the price actually filled.",
    why: "Measured from real fills, it is how you tell whether a strategy survives contact with a real market.",
  },
  "kill-switch": {
    term: "Kill switch",
    plain: "A single setting that blocks every order, immediately and globally.",
    why: "When engaged, no path in the code can place a trade — not manual, not scheduled.",
  },
  "mcp": {
    term: "MCP (Model Context Protocol)",
    plain: "A standard way for AI models to call external tools — here, Alpaca's own trading server.",
    why: "VolGuard runs Alpaca's official MCP server and records real read-only calls to it in the audit log.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type TermKey = keyof typeof GLOSSARY;

export function isTermKey(value: string): value is TermKey {
  return Object.hasOwn(GLOSSARY, value);
}

// ── Scan verdicts ───────────────────────────────────────────────────────────

/**
 * Turns a scan verdict such as `jump-contaminated (49%)` into a sentence. The patterns are
 * anchored to the exact strings `decideStrategy` produces; an unrecognised verdict returns a
 * neutral fallback rather than inventing meaning.
 */
export function explainVerdict(verdict: string): Explanation {
  const jump = /^jump-contaminated \((\d+)%\)/.exec(verdict);
  if (jump) {
    return {
      headline: "Skipped — the volatility reading is distorted",
      detail: `${jump[1]}% of this stock's recent movement came from sudden gaps rather than normal daily drift. That makes it look volatile because of something that already happened, which says nothing about what comes next.`,
      tone: "warn",
    };
  }

  const event = /^event risk (\d+)/.exec(verdict);
  if (event) {
    return {
      headline: "Skipped — a known event is coming",
      detail: `Event risk scores ${event[1]} out of 100. Options are expensive here for a reason, not by mistake, so there is no mispricing to collect.`,
      tone: "warn",
    };
  }

  const rich = /^IV rich \(\+([\d.]+)v\)/.exec(verdict);
  if (rich) {
    return {
      headline: "Skipped — options are too expensive",
      detail: `Options are charging ${rich[1]} volatility points more than this stock actually delivers. VolGuard only ever buys options, so an expensive market is a reason to wait.`,
      tone: "neutral",
    };
  }

  if (/^backwardation/.test(verdict)) {
    return {
      headline: "Skipped — the market expects a shock soon",
      detail: "Near-dated options cost more than longer-dated ones. That pattern usually means something is coming that the news scan did not identify by name.",
      tone: "warn",
    };
  }

  const cheap = /^IV cheap \((-?[\d.]+)v\) → (call|put) debit spread/.exec(verdict);
  if (cheap) {
    const bullish = cheap[2] === "call";
    return {
      headline: `Candidate — options look cheap${bullish ? ", leaning up" : ", leaning down"}`,
      detail: `Options are charging ${Math.abs(Number(cheap[1])).toFixed(1)} volatility points less than this stock actually delivers. The cheap movement is bought as a defined-risk ${bullish ? "call" : "put"} spread, so the most that can be lost is the amount paid.`,
      tone: "good",
    };
  }

  if (/^no volatility data/.test(verdict)) {
    return {
      headline: "Skipped — not enough data",
      detail: "Alpaca did not return enough price or options data to compare what options cost against what the stock delivers.",
      tone: "neutral",
    };
  }

  return { headline: verdict, detail: "", tone: "neutral" };
}

/** Compact label for the scan table in beginner mode. */
export function verdictChip(verdict: string): { label: string; tone: Tone } {
  const explanation = explainVerdict(verdict);
  if (/^IV cheap/.test(verdict)) return { label: "Candidate", tone: "good" };
  if (/^jump-contaminated/.test(verdict)) return { label: "Distorted", tone: "warn" };
  if (/^event risk/.test(verdict)) return { label: "Event soon", tone: "warn" };
  if (/^IV rich/.test(verdict)) return { label: "Too pricey", tone: "neutral" };
  if (/^backwardation/.test(verdict)) return { label: "Shock priced", tone: "warn" };
  if (/^no volatility data/.test(verdict)) return { label: "No data", tone: "neutral" };
  return { label: explanation.headline, tone: "neutral" };
}

// ── Statuses ────────────────────────────────────────────────────────────────

export function explainStatus(status: DecisionStatus): Explanation {
  switch (status) {
    case "TRADE_APPROVED":
      return {
        headline: "Trade approved",
        detail: "Every safety check passed and the order was constructed with its maximum loss known in advance.",
        tone: "good",
      };
    case "TRADE_REJECTED":
      return {
        headline: "Blocked by a safety check",
        detail: "A candidate existed, but at least one hard limit failed. The failing checks are named below — this is the system working, not failing.",
        tone: "bad",
      };
    case "NO_TRADE":
      return {
        headline: "Standing aside",
        detail: "Nothing met the standard for a trade. Doing nothing is the correct output most of the time.",
        tone: "neutral",
      };
    case "CONFIGURATION_REQUIRED":
      return {
        headline: "Setup needed",
        detail: "Alpaca paper credentials are missing or do not match the configured account, so no analysis can run.",
        tone: "warn",
      };
    case "DATA_UNAVAILABLE":
      return {
        headline: "Not enough live data",
        detail: "The market data needed to price this properly was missing or too stale to trust.",
        tone: "warn",
      };
    case "ERROR":
      return {
        headline: "Something went wrong",
        detail: "The run stopped on an unexpected error. The audit log records what happened.",
        tone: "bad",
      };
  }
}

export function explainEventSeverity(severity: EventSeverity): string {
  switch (severity) {
    case "none": return "No known catalyst in the holding window.";
    case "low": return "Minor news, not enough to change the decision.";
    case "elevated": return "Something meaningful is scheduled. Treated with caution.";
    case "high": return "A major known catalyst lands inside the window. Trading is blocked.";
  }
}

// ── Risk gates ──────────────────────────────────────────────────────────────

/**
 * Plain-language names for every gate in `evaluateRisk`, phrased as the question the gate
 * answers so that a passing tick reads as reassurance. Any gate missing from this map falls
 * back to its underscored name, and a test asserts the map stays complete.
 */
const GATE_LABELS: Record<string, string> = {
  paper_environment: "Paper account only, never real money",
  kill_switch: "Emergency stop is off",
  account_status: "Brokerage account is active",
  options_level: "Account is approved for spreads",
  market_open: "Market is open for trading",
  two_leg_spread: "Exactly two option legs",
  defined_risk: "Losses are capped by design",
  same_expiry: "Both legs expire on the same day",
  same_option_type: "Both legs are the same option type",
  all_option_legs: "Every leg is an option contract",
  price_below_width: "Costs less than the most it can pay",
  positive_net_price: "Price is a sensible positive number",
  max_loss_matches_width: "Worst case is capped by the strike width",
  equal_leg_ratios: "Both legs trade in equal size",
  credit_spreads_enabled: "Premium selling is switched on",
  whole_quantity: "A whole number of contracts",
  time_in_force: "Order expires today if unfilled",
  quote_freshness: "Prices are current, not stale",
  spread_quality: "Bid–ask gap is tight enough",
  quote_depth: "Enough contracts available to trade",
  size_vs_depth: "Order size fits what is on offer",
  max_loss_per_trade: "Within the per-trade loss limit",
  equity_risk: "Within the share-of-account limit",
  daily_loss_limit: "Within today's loss budget",
  portfolio_exposure: "Within the total open-risk limit",
  open_positions: "Below the maximum open positions",
  buying_power: "Enough buying power to cover it",
  no_duplicate_order: "Not a duplicate of an existing order",
  reward_risk: "Payout justifies the risk",
  open_interest: "Contract is actively traded",
};

export function explainGate(name: string): string {
  return GATE_LABELS[name] ?? name.replace(/_/g, " ");
}

export function gateLabelCount(): number {
  return Object.keys(GATE_LABELS).length;
}

// ── Whole-run summary ───────────────────────────────────────────────────────

export interface PlainDecision {
  headline: string;
  /** Why the agent reached this outcome, in one or two plain sentences. */
  why: string;
  /** What a viewer should take from it. */
  soWhat: string;
  tone: Tone;
}

/**
 * The one paragraph a non-trader reads to understand a run. Built from the run's own fields
 * so it can never disagree with the numbers rendered beside it.
 */
export function plainDecision(run: AgentRun): PlainDecision {
  const status = explainStatus(run.status);
  const symbol = run.symbol;
  const scanned = run.scanned.length;

  if (run.status === "TRADE_APPROVED" && run.orderIntent) {
    const intent = run.orderIntent;
    const bullish = intent.strategy === "bull_call_debit_spread";
    return {
      headline: `Buying cheap movement in ${symbol}`,
      why: `Of ${scanned} stocks checked, ${symbol} was charging the least for movement relative to how much it actually moves, with no known event to explain it.`,
      soWhat: `The position is a ${bullish ? "call" : "put"} spread costing ${money(intent.maxLoss)}. That is the most it can lose, fixed before the order was sent; the most it can make is ${money(intent.maxProfit)}.`,
      tone: "good",
    };
  }

  if (run.status === "TRADE_REJECTED") {
    const failed = (run.risk?.checks ?? []).filter((c) => c.blocking && !c.passed);
    const names = failed.map((c) => explainGate(c.name).toLowerCase());
    return {
      headline: `Found a setup in ${symbol}, then refused it`,
      why: names.length > 0
        ? `${failed.length} safety check${failed.length === 1 ? "" : "s"} failed: ${names.join("; ")}.`
        : "A safety check failed before the order could be sent.",
      soWhat: "No order was placed. The agent is allowed to find an idea and still decline to act on it — that veto is the point.",
      tone: "bad",
    };
  }

  if (run.status === "NO_TRADE") {
    const closed = /market is closed/i.test(run.message);
    if (closed) {
      return {
        headline: "Market closed — analysis only",
        why: `All ${scanned} stocks were scored on the most recent session's data.${symbol ? ` ${symbol} is the standing candidate.` : ""}`,
        soWhat: "No order can be built outside trading hours, so the agent stops at analysis. It will act on its own when the market opens if the setup still holds.",
        tone: "neutral",
      };
    }
    return {
      headline: "Nothing worth trading",
      why: `All ${scanned} stocks were checked and none met the standard${symbol ? `; ${symbol} came closest` : ""}.`,
      soWhat: "Standing aside is the normal outcome. An agent that always finds a trade is not being selective.",
      tone: "neutral",
    };
  }

  return { headline: status.headline, why: run.message, soWhat: status.detail, tone: status.tone };
}

/**
 * The one-line version, for the guided view.
 *
 * `plainDecision` writes two or three sentences, which is the right amount when a reader has
 * committed to reading. On first contact it is a wall. This says the same thing in a headline
 * and a single line; everything it leaves out is available on tap, never deleted.
 */
export interface BriefDecision {
  headline: string;
  line: string;
  tone: Tone;
}

export function briefDecision(run: AgentRun): BriefDecision {
  const symbol = run.symbol ?? "this stock";
  const vrp = run.observation?.volatility.varianceRiskPremium ?? null;
  const points = vrp === null ? null : Math.abs(vrp * 100).toFixed(1);

  if (run.status === "TRADE_APPROVED") {
    return {
      headline: `${symbol} — options look cheap`,
      line: points
        ? `Cheaper by ${points} points than ${symbol} actually moves.`
        : `Priced below what ${symbol} actually moves.`,
      tone: "good",
    };
  }

  if (run.status === "TRADE_REJECTED") {
    const failed = (run.risk?.checks ?? []).filter((c) => c.blocking && !c.passed).length;
    return {
      headline: "Found a setup, then refused it",
      line: `${failed || "A"} safety check${failed === 1 ? "" : "s"} failed, so nothing was sent.`,
      tone: "bad",
    };
  }

  if (run.status === "NO_TRADE") {
    if (/market is closed/i.test(run.message)) {
      return {
        headline: "Market closed",
        line: `Analysis only. ${symbol} is the standing candidate when it reopens.`,
        tone: "neutral",
      };
    }
    return {
      headline: "Nothing worth buying",
      line: `None of the ${run.scanned.length} stocks met the standard today.`,
      tone: "neutral",
    };
  }

  const status = explainStatus(run.status);
  return { headline: status.headline, line: status.detail, tone: status.tone };
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}
