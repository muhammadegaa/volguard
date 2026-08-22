import type { AlpacaNewsItem, EventRisk, EventSeverity } from "./types";

/**
 * Event taxonomy. Weight is the contribution to the event score for a fresh match.
 * These are scheduled-or-binary catalysts that make implied volatility expensive for a
 * reason, which is exactly when a long-premium agent should stand aside.
 */
const TAXONOMY: Array<{ category: string; weight: number; patterns: RegExp }> = [
  // The top three are binary catalysts. A single fresh, symbol-specific match is enough
  // to clear the default abstain threshold on its own: when the market knows something is
  // coming, expensive premium is compensation rather than a mispricing to buy.
  { category: "earnings", weight: 65, patterns: /\b(earnings|q[1-4] results|quarterly results|reports? (?:q[1-4]|earnings)|eps beat|eps miss|guidance)\b/i },
  { category: "regulatory", weight: 60, patterns: /\b(fda|approval|clinical trial|phase [123]|antitrust|sec (?:probe|investigation|charges)|doj)\b/i },
  { category: "mna", weight: 60, patterns: /\b(acquisition|acquires?|merger|takeover|buyout|bid for|to be acquired)\b/i },
  { category: "macro", weight: 35, patterns: /\b(fomc|federal reserve|fed (?:meeting|decision|chair)|cpi|inflation report|jobs report|nonfarm|rate (?:cut|hike|decision))\b/i },
  { category: "policy", weight: 25, patterns: /\b(tariff|sanction|export (?:ban|control)|trade (?:deal|war))\b/i },
  { category: "legal", weight: 25, patterns: /\b(lawsuit|sues?|settlement|verdict|injunction|recall)\b/i },
  { category: "leadership", weight: 18, patterns: /\b(ceo|cfo|resigns?|steps down|appoints?|layoffs?|restructuring)\b/i },
  { category: "rating", weight: 12, patterns: /\b(upgrade[sd]?|downgrade[sd]?|price target|initiated coverage|outperform|underperform)\b/i },
];

/** Fresh news matters more. Decays to zero over 72 hours. */
function recencyWeight(createdAt: string, nowMs: number): number {
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return 0;
  const hours = (nowMs - ts) / 3_600_000;
  if (hours < 0) return 1;
  if (hours > 72) return 0;
  return 1 - hours / 72;
}

function severityFor(score: number): EventSeverity {
  if (score >= 75) return "high";
  if (score >= 45) return "elevated";
  if (score >= 15) return "low";
  return "none";
}

/**
 * Classify event risk for one symbol. Raw headline count is deliberately not the signal:
 * ten rating notes are not the same risk as one FDA decision, so only taxonomy matches
 * score, weighted by recency and by whether the headline names this symbol directly.
 */
export function classifyEventRisk(input: {
  symbol: string;
  news: AlpacaNewsItem[];
  corporateActions: string[];
  now?: Date;
}): EventRisk {
  const nowMs = (input.now ?? new Date()).getTime();
  const matched: EventRisk["matchedHeadlines"] = [];
  const byCategory = new Map<string, number>();

  for (const item of input.news) {
    const headline = item.headline ?? "";
    const weightNow = recencyWeight(item.created_at, nowMs);
    if (weightNow <= 0) continue;
    // A headline tagged with many tickers is broad-market noise for this symbol.
    const focus = Array.isArray(item.symbols) && item.symbols.length > 0
      ? (item.symbols.includes(input.symbol) ? 1 / Math.sqrt(item.symbols.length) : 0.25)
      : 0.5;

    for (const rule of TAXONOMY) {
      if (!rule.patterns.test(headline)) continue;
      const contribution = rule.weight * weightNow * focus;
      byCategory.set(rule.category, Math.max(byCategory.get(rule.category) ?? 0, contribution));
      matched.push({
        headline: headline.slice(0, 180),
        source: item.source ?? "unknown",
        createdAt: item.created_at,
        category: rule.category,
      });
      break;
    }
  }

  // Take the strongest match per category, then damp the tail so volume alone cannot
  // manufacture a high score.
  const contributions = [...byCategory.values()].sort((a, b) => b - a);
  let score = contributions.reduce((sum, value, index) => sum + value / (index + 1), 0);
  const actionDrivers = input.corporateActions.slice(0, 5);
  if (actionDrivers.length > 0) score += 10;
  score = Math.min(100, Math.round(score));

  const drivers = [
    ...[...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, value]) => `${category} (+${Math.round(value)})`),
    ...actionDrivers.map((action) => `corporate action: ${action}`),
  ];

  return {
    severity: severityFor(score),
    score,
    drivers: drivers.length > 0 ? drivers : ["no scheduled or headline catalyst matched the taxonomy"],
    newsCount: input.news.length,
    matchedHeadlines: matched
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 6),
    corporateActions: actionDrivers,
  };
}
