import Anthropic from "@anthropic-ai/sdk";
import type { StrategyVerdict } from "./strategy";
import { TradeThesisSchema, type MarketObservation, type TradeThesis } from "./types";

/**
 * The deterministic strategy layer has already decided what to do. The model's job is to
 * narrate that decision in the operator's language and to stress-test it — it may
 * downgrade a trade to no_trade, but it can never invent a strategy the rules rejected.
 */
function pct(value: number | null, digits = 1): string {
  return value === null ? "unavailable" : `${(value * 100).toFixed(digits)}%`;
}

export function fallbackThesis(observation: MarketObservation, verdict: StrategyVerdict): TradeThesis {
  const vol = observation.volatility;
  const trade = verdict.strategy !== "no_trade";
  return {
    symbol: observation.symbol,
    direction: verdict.direction,
    thesis: trade
      ? `Implied volatility for the ${observation.targetExpiry} expiry is ${pct(vol.atmImpliedVol)} against ${pct(vol.bipowerVol20)} jump-robust realized over 20 days, so the market is charging ${pct(vol.varianceRiskPremium)} less for movement than ${observation.symbol} has been delivering. A defined-risk debit spread buys that convexity with the loss capped at the premium paid.`
      : `${observation.symbol} does not clear the entry gate. ${verdict.rationale[verdict.rationale.length - 1] ?? "No qualifying volatility mispricing was found."}`,
    catalyst: trade
      ? `Cheap optionality relative to delivered movement, with event risk scored at ${observation.event.score}/100 (${observation.event.severity}).`
      : `No qualifying setup: ${verdict.verdict}.`,
    invalidation: trade
      ? `Exit if the spread reaches the take-profit or stop level, if fewer than 7 days to expiry remain, or if implied volatility richens back above realized.`
      : "Not applicable; no position is proposed.",
    confidence: verdict.confidence,
    strategy: verdict.strategy,
    source: "rules_fallback",
  };
}

const SYSTEM = [
  "You are the research analyst inside VolGuard, a defined-risk options agent.",
  "A deterministic strategy engine has already run. Your job is to explain its decision in plain language and to challenge it.",
  "Hard rules:",
  "- Use only the numbers in the observation. Never invent prices, volumes, greeks or events.",
  "- You may keep the proposed strategy, or downgrade it to no_trade if the evidence is weak. You may NEVER upgrade no_trade into a trade, and never propose a different strategy than the one supplied.",
  "- VolGuard buys premium only. Rich implied volatility is a reason to abstain, not to sell.",
  "- Return only valid JSON matching the schema. No prose outside the JSON.",
].join("\n");

/**
 * Narrate and stress-test the engine's decision.
 *
 * Every failure path returns the rules-engine thesis labelled `rules_fallback`, so a
 * missing key, an outage, a refusal or malformed output degrades into an honest,
 * fully-attributed decision rather than blocking the run or faking model reasoning.
 */
export async function generateThesis(
  observation: MarketObservation,
  verdict: StrategyVerdict,
): Promise<TradeThesis> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = fallbackThesis(observation, verdict);
  if (!apiKey) return fallback;

  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });

  try {
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: JSON.stringify({
          task: "Explain and stress-test this volatility setup.",
          engineDecision: { strategy: verdict.strategy, direction: verdict.direction, rationale: verdict.rationale },
          observation,
          schema: {
            symbol: "string, must equal observation.symbol",
            direction: "bullish | bearish | neutral",
            thesis: "2-4 sentences on why implied vol is mispriced against realized, and what the spread buys",
            catalyst: "what makes this actionable now",
            invalidation: "the specific condition that kills the trade",
            confidence: "number 0 to 1",
            strategy: `must be "${verdict.strategy}" or "no_trade"`,
          },
        }),
      }],
    });

    if (response.stop_reason === "refusal") return fallback;
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return fallback;

    const parsed = TradeThesisSchema.safeParse({ ...JSON.parse(json), source: "anthropic" });
    if (!parsed.success) return fallback;

    // The model may only agree or de-escalate. Anything else falls back to the engine.
    const allowed = parsed.data.strategy === verdict.strategy || parsed.data.strategy === "no_trade";
    if (!allowed || parsed.data.symbol !== observation.symbol) return fallback;
    return parsed.data;
  } catch {
    return fallback;
  }
}
