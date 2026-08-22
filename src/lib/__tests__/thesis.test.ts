import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyEventRisk } from "../events";
import { fallbackThesis, generateThesis } from "../thesis";
import type { StrategyVerdict } from "../strategy";
import type { MarketObservation } from "../types";

const create = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const ORIGINAL = { ...process.env };

const observation: MarketObservation = {
  symbol: "SPY", price: 500, previousClose: 498, dailyReturn: 0.004, trend: 0.01,
  volatility: {
    realizedVol20: 0.25, realizedVol10: 0.25, realizedVol5: 0.25, bipowerVol20: 0.25, jumpFraction: 0,
    parkinsonVol20: 0.24,
    realizedVolRank: 0.5, atmImpliedVol: 0.18, frontImpliedVol: 0.18, backImpliedVol: 0.19,
    termSlope: 0.01, varianceRiskPremium: -0.07, trailingVarianceRiskPremium: -0.07,
    forecastVol: 0.25, forecastSource: "har", forecastHorizonDays: 30, forecastR2: 0.4,
    skew25: 0.01, impliedVolRank: null, ivSamples: 3,
  },
  event: classifyEventRisk({ symbol: "SPY", news: [], corporateActions: [] }),
  targetExpiry: "2026-09-18", daysToExpiry: 30, chainContracts: 120,
  dataAsOf: "2026-08-19T16:00:00Z", source: "alpaca", unavailable: [],
};

const verdict: StrategyVerdict = {
  strategy: "bull_call_debit_spread",
  direction: "bullish",
  confidence: 0.6,
  rationale: ["IV is below realized."],
  verdict: "IV cheap",
};

/** Shape of a real Messages API response, narrowed to what generateThesis reads. */
function modelResponse(body: unknown, stopReason = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text: JSON.stringify(body) }] };
}

const valid = {
  symbol: "SPY", direction: "bullish", thesis: "Implied is under realized.",
  catalyst: "Cheap convexity.", invalidation: "IV richens.", confidence: 0.55,
  strategy: "bull_call_debit_spread",
};

beforeEach(() => {
  create.mockReset();
  process.env.ANTHROPIC_API_KEY = "test";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("fallbackThesis", () => {
  it("is labelled as the rules engine, never as model output", () => {
    expect(fallbackThesis(observation, verdict).source).toBe("rules_fallback");
  });

  it("quotes the actual implied and realized numbers", () => {
    const thesis = fallbackThesis(observation, verdict);
    expect(thesis.thesis).toContain("18.0%");
    expect(thesis.thesis).toContain("25.0%");
  });

  it("carries the engine's no_trade decision through", () => {
    const abstain: StrategyVerdict = { ...verdict, strategy: "no_trade", direction: "neutral", confidence: 0, verdict: "IV rich" };
    expect(fallbackThesis(observation, abstain).strategy).toBe("no_trade");
  });
});

describe("generateThesis", () => {
  it("uses the fallback and makes no API call without a key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const thesis = await generateThesis(observation, verdict);
    expect(thesis.source).toBe("rules_fallback");
    expect(create).not.toHaveBeenCalled();
  });

  it("accepts a well-formed model thesis that agrees with the engine", async () => {
    create.mockResolvedValue(modelResponse(valid));
    const thesis = await generateThesis(observation, verdict);
    expect(thesis.source).toBe("anthropic");
    expect(thesis.confidence).toBe(0.55);
  });

  it("sends the engine decision and the observation to the model", async () => {
    create.mockResolvedValue(modelResponse(valid));
    await generateThesis(observation, verdict);
    const payload = create.mock.calls[0][0];
    expect(payload.system).toMatch(/never upgrade no_trade/i);
    expect(payload.messages[0].content).toContain("bull_call_debit_spread");
    expect(payload.messages[0].content).toContain("varianceRiskPremium");
  });

  it("lets the model veto a trade down to no_trade", async () => {
    create.mockResolvedValue(modelResponse({ ...valid, direction: "neutral", strategy: "no_trade", confidence: 0.1 }));
    expect((await generateThesis(observation, verdict)).strategy).toBe("no_trade");
  });

  it("refuses a model that tries to upgrade an abstain into a trade", async () => {
    const abstain: StrategyVerdict = { ...verdict, strategy: "no_trade", confidence: 0 };
    create.mockResolvedValue(modelResponse({ ...valid, confidence: 0.99 }));
    const thesis = await generateThesis(observation, abstain);
    expect(thesis.source).toBe("rules_fallback");
    expect(thesis.strategy).toBe("no_trade");
  });

  it("refuses a model that swaps in a different strategy", async () => {
    create.mockResolvedValue(modelResponse({ ...valid, direction: "bearish", strategy: "bear_put_debit_spread" }));
    expect((await generateThesis(observation, verdict)).source).toBe("rules_fallback");
  });

  it("refuses a model that changes the symbol", async () => {
    create.mockResolvedValue(modelResponse({ ...valid, symbol: "TSLA" }));
    expect((await generateThesis(observation, verdict)).symbol).toBe("SPY");
  });

  it("falls back on a safety refusal", async () => {
    create.mockResolvedValue(modelResponse(valid, "refusal"));
    expect((await generateThesis(observation, verdict)).source).toBe("rules_fallback");
  });

  it("falls back on schema-invalid model output", async () => {
    create.mockResolvedValue(modelResponse({ symbol: "SPY", confidence: 42 }));
    expect((await generateThesis(observation, verdict)).source).toBe("rules_fallback");
  });

  it("falls back on non-JSON model output", async () => {
    create.mockResolvedValue({ stop_reason: "end_turn", content: [{ type: "text", text: "I refuse." }] });
    expect((await generateThesis(observation, verdict)).source).toBe("rules_fallback");
  });

  it("falls back when the API throws, including billing and rate-limit errors", async () => {
    create.mockRejectedValue(new Error("Your credit balance is too low to access the Anthropic API"));
    const thesis = await generateThesis(observation, verdict);
    expect(thesis.source).toBe("rules_fallback");
    expect(thesis.strategy).toBe("bull_call_debit_spread");
  });

  it("never blocks the run: a model failure still yields a usable decision", async () => {
    create.mockRejectedValue(new Error("network down"));
    const thesis = await generateThesis(observation, verdict);
    expect(thesis.confidence).toBe(verdict.confidence);
    expect(thesis.symbol).toBe("SPY");
  });
});
