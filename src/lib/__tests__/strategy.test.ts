import { describe, expect, it } from "vitest";
import { classifyEventRisk } from "../events";
import { decideStrategy } from "../strategy";
import type { VolGuardConfig } from "../config";
import type { MarketObservation, VolatilityState } from "../types";

const config = {
  maxEntryVrp: 0,
  maxEventScore: 60,
  maxJumpFraction: 0.35,
} as VolGuardConfig;

function volatility(overrides: Partial<VolatilityState> = {}): VolatilityState {
  return {
    realizedVol20: 0.25, realizedVol10: 0.25, realizedVol5: 0.25, bipowerVol20: 0.25, jumpFraction: 0,
    parkinsonVol20: 0.24,
    realizedVolRank: 0.5, atmImpliedVol: 0.18, frontImpliedVol: 0.18, backImpliedVol: 0.19,
    termSlope: 0.01, varianceRiskPremium: -0.07, trailingVarianceRiskPremium: -0.07,
    forecastVol: 0.25, forecastSource: "har", forecastHorizonDays: 30, forecastR2: 0.4,
    skew25: 0.01, impliedVolRank: null, ivSamples: 3,
    ...overrides,
  };
}

function observation(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    symbol: "SPY", price: 500, previousClose: 498, dailyReturn: 0.004, trend: 0.01,
    volatility: volatility(),
    event: classifyEventRisk({ symbol: "SPY", news: [], corporateActions: [] }),
    targetExpiry: "2026-09-18", daysToExpiry: 30, chainContracts: 120,
    dataAsOf: new Date().toISOString(), source: "alpaca", unavailable: [],
    ...overrides,
  };
}

describe("decideStrategy", () => {
  it("buys convexity when implied volatility is cheap against realized", () => {
    const verdict = decideStrategy(observation(), config);
    expect(verdict.strategy).toBe("bull_call_debit_spread");
    expect(verdict.confidence).toBeGreaterThan(0);
    expect(verdict.rationale.join(" ")).toMatch(/variance risk premium/i);
  });

  it("abstains when options are rich, because VolGuard only ever buys premium", () => {
    const rich = observation({ volatility: volatility({ atmImpliedVol: 0.35, bipowerVol20: 0.25, varianceRiskPremium: 0.1 }) });
    const verdict = decideStrategy(rich, config);
    expect(verdict.strategy).toBe("no_trade");
    expect(verdict.verdict).toMatch(/rich/i);
  });

  it("abstains when a known catalyst explains the premium", () => {
    const event = classifyEventRisk({
      symbol: "AAPL",
      news: [{
        headline: "Apple reports Q3 earnings after the bell",
        source: "benzinga",
        created_at: new Date().toISOString(),
        symbols: ["AAPL"],
      }],
      corporateActions: [],
    });
    const verdict = decideStrategy(observation({ symbol: "AAPL", event }), config);
    expect(verdict.strategy).toBe("no_trade");
    expect(verdict.verdict).toMatch(/event risk/i);
  });

  it("abstains when realized volatility is dominated by a jump that already happened", () => {
    const jumpy = observation({
      volatility: volatility({ realizedVol20: 0.58, bipowerVol20: 0.41, jumpFraction: 0.49, varianceRiskPremium: -0.17 }),
    });
    const verdict = decideStrategy(jumpy, config);
    expect(verdict.strategy).toBe("no_trade");
    expect(verdict.verdict).toMatch(/jump-contaminated/);
    expect(verdict.rationale.join(" ")).toMatch(/already happened/);
  });

  it("still trades when the cheapness survives the jump-robust baseline", () => {
    const clean = observation({
      volatility: volatility({ realizedVol20: 0.30, bipowerVol20: 0.29, jumpFraction: 0.06, varianceRiskPremium: -0.11 }),
    });
    expect(decideStrategy(clean, config).strategy).toBe("bull_call_debit_spread");
  });

  it("prices the variance risk premium against bipower, not raw realized", () => {
    const verdict = decideStrategy(observation(), config);
    expect(verdict.rationale.join(" ")).toMatch(/jump-robust realized/);
  });

  it("abstains when the term structure is in backwardation", () => {
    const stressed = observation({ volatility: volatility({ termSlope: -0.05 }) });
    expect(decideStrategy(stressed, config).strategy).toBe("no_trade");
  });

  it("abstains when implied or realized volatility is unavailable", () => {
    const blind = observation({ volatility: volatility({ atmImpliedVol: null, bipowerVol20: null, varianceRiskPremium: null }) });
    const verdict = decideStrategy(blind, config);
    expect(verdict.strategy).toBe("no_trade");
    expect(verdict.confidence).toBe(0);
  });

  it("chooses the put side when the tape is weak", () => {
    const weak = observation({ trend: -0.03 });
    expect(decideStrategy(weak, config).strategy).toBe("bear_put_debit_spread");
  });

  it("chooses the put side when downside skew is bid with a flat tape", () => {
    const skewed = observation({ trend: 0.001, volatility: volatility({ skew25: 0.06 }) });
    expect(decideStrategy(skewed, config).strategy).toBe("bear_put_debit_spread");
  });

  it("never returns a confidence above 0.85", () => {
    const extreme = observation({ volatility: volatility({ varianceRiskPremium: -0.9 }) });
    expect(decideStrategy(extreme, config).confidence).toBeLessThanOrEqual(0.85);
  });
});

describe("classifyEventRisk", () => {
  const now = new Date("2026-08-19T16:00:00Z");
  const fresh = (headline: string, symbols = ["AAPL"]) => ({
    headline, source: "benzinga", created_at: "2026-08-19T15:30:00Z", symbols,
  });

  it("scores a scheduled binary catalyst as elevated", () => {
    const risk = classifyEventRisk({ symbol: "AAPL", news: [fresh("Apple Q3 earnings due Thursday")], corporateActions: [], now });
    expect(risk.score).toBeGreaterThanOrEqual(15);
    expect(risk.matchedHeadlines[0].category).toBe("earnings");
  });

  it("does not treat headline volume alone as risk", () => {
    const noise = Array.from({ length: 20 }, (_, i) => fresh(`Apple stock moves in early trading ${i}`));
    const risk = classifyEventRisk({ symbol: "AAPL", news: noise, corporateActions: [], now });
    expect(risk.newsCount).toBe(20);
    expect(risk.score).toBe(0);
    expect(risk.severity).toBe("none");
  });

  it("decays stale headlines to zero", () => {
    const old = { ...fresh("Apple Q3 earnings"), created_at: "2026-08-01T00:00:00Z" };
    expect(classifyEventRisk({ symbol: "AAPL", news: [old], corporateActions: [], now }).score).toBe(0);
  });

  it("discounts a headline that names many unrelated tickers", () => {
    const focused = classifyEventRisk({ symbol: "AAPL", news: [fresh("AAPL merger talks", ["AAPL"])], corporateActions: [], now }).score;
    const broad = classifyEventRisk({
      symbol: "AAPL",
      news: [fresh("Sector merger talks", ["AAPL", "MSFT", "GOOG", "AMZN", "META", "NVDA"])],
      corporateActions: [],
      now,
    }).score;
    expect(broad).toBeLessThan(focused);
  });

  it("adds corporate actions as a driver", () => {
    const risk = classifyEventRisk({ symbol: "AAPL", news: [], corporateActions: ["cash dividends ex-date 2026-08-25"], now });
    expect(risk.score).toBeGreaterThan(0);
    expect(risk.drivers.join(" ")).toMatch(/corporate action/);
  });

  it("caps the score at 100", () => {
    const everything = [
      fresh("Apple earnings guidance"), fresh("Apple FDA approval"), fresh("Apple merger"),
      fresh("FOMC rate decision"), fresh("New tariff announced"), fresh("Apple lawsuit verdict"),
      fresh("Apple CEO resigns"), fresh("Apple upgraded"),
    ];
    expect(classifyEventRisk({ symbol: "AAPL", news: everything, corporateActions: ["split"], now }).score).toBeLessThanOrEqual(100);
  });
});
