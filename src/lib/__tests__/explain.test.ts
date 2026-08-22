import { beforeEach, describe, expect, it } from "vitest";
import {
  GLOSSARY,
  briefDecision,
  explainGate,
  explainStatus,
  explainVerdict,
  gateLabelCount,
  isTermKey,
  plainDecision,
  verdictChip,
} from "../explain";
import { evaluateRisk } from "../risk";
import type { AgentRun, DecisionStatus } from "../types";
import { intent, paperEnv, riskBase } from "./fixtures";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run-1",
    startedAt: "2026-08-20T13:00:00.000Z",
    finishedAt: "2026-08-20T13:00:03.000Z",
    mode: "dry-run",
    trigger: "manual",
    status: "NO_TRADE",
    symbol: "QQQ",
    scanned: [
      { symbol: "SPY", verdict: "event risk 66", varianceRiskPremium: -0.02, observation: null },
      { symbol: "QQQ", verdict: "IV cheap (-4.1v) → call debit spread", varianceRiskPremium: -0.04, observation: null },
    ],
    observation: null,
    thesis: null,
    risk: null,
    orderIntent: null,
    alpacaOrderId: null,
    positionReviews: [],
    exitOrderIds: [],
    durationMs: 3000,
    message: "",
    ...overrides,
  };
}

describe("explainVerdict", () => {
  it("explains a cheap-volatility candidate and names the direction", () => {
    const e = explainVerdict("IV cheap (-4.1v) → call debit spread");
    expect(e.tone).toBe("good");
    expect(e.headline).toMatch(/cheap/i);
    expect(e.detail).toMatch(/4\.1 volatility points/);
    expect(e.detail).toMatch(/call spread/);
  });

  it("explains the put side when the scan leans bearish", () => {
    expect(explainVerdict("IV cheap (-3.0v) → put debit spread").detail).toMatch(/put spread/);
  });

  it("carries the jump percentage into the explanation", () => {
    const e = explainVerdict("jump-contaminated (49%)");
    expect(e.detail).toMatch(/49%/);
    expect(e.tone).toBe("warn");
  });

  it("carries the event score into the explanation", () => {
    expect(explainVerdict("event risk 66").detail).toMatch(/66 out of 100/);
  });

  it("explains rich options as a reason to wait rather than a failure", () => {
    const e = explainVerdict("IV rich (+4.4v)");
    expect(e.detail).toMatch(/4\.4 volatility points/);
    expect(e.tone).toBe("neutral");
  });

  it("explains backwardation without using the word", () => {
    const e = explainVerdict("backwardation");
    expect(e.headline).not.toMatch(/backwardation/i);
    expect(e.headline).toMatch(/shock/i);
  });

  it("explains missing data", () => {
    expect(explainVerdict("no volatility data").headline).toMatch(/not enough data/i);
  });

  it("never invents meaning for an unrecognised verdict", () => {
    const e = explainVerdict("something entirely new");
    expect(e.headline).toBe("something entirely new");
    expect(e.detail).toBe("");
  });

  it("uses no jargon in any beginner headline", () => {
    const jargon = /\b(VRP|IV|RV|implied|realized|bipower|backwardation|delta|theta|skew|convexity)\b/i;
    for (const verdict of [
      "IV cheap (-4.1v) → call debit spread",
      "IV rich (+4.4v)",
      "jump-contaminated (49%)",
      "event risk 66",
      "backwardation",
      "no volatility data",
    ]) {
      expect(explainVerdict(verdict).headline, `jargon in: ${verdict}`).not.toMatch(jargon);
    }
  });
});

describe("verdictChip", () => {
  it("gives every known verdict a short label", () => {
    expect(verdictChip("IV cheap (-4.1v) → call debit spread")).toEqual({ label: "Candidate", tone: "good" });
    expect(verdictChip("jump-contaminated (49%)").label).toBe("Distorted");
    expect(verdictChip("event risk 66").label).toBe("Event soon");
    expect(verdictChip("IV rich (+4.4v)").label).toBe("Too pricey");
    expect(verdictChip("backwardation").label).toBe("Shock priced");
    expect(verdictChip("no volatility data").label).toBe("No data");
  });

  it("keeps every chip short enough for a narrow column", () => {
    for (const verdict of ["IV cheap (-4.1v) → call debit spread", "event risk 66", "backwardation"]) {
      expect(verdictChip(verdict).label.length).toBeLessThanOrEqual(14);
    }
  });
});

describe("explainStatus", () => {
  const statuses: DecisionStatus[] = [
    "TRADE_APPROVED", "TRADE_REJECTED", "NO_TRADE",
    "CONFIGURATION_REQUIRED", "DATA_UNAVAILABLE", "ERROR",
  ];

  it("explains every decision status the agent can return", () => {
    for (const status of statuses) {
      const e = explainStatus(status);
      expect(e.headline.length, status).toBeGreaterThan(0);
      expect(e.detail.length, status).toBeGreaterThan(0);
    }
  });

  it("frames a rejection as the system working", () => {
    expect(explainStatus("TRADE_REJECTED").detail).toMatch(/working, not failing/);
  });

  it("frames standing aside as a normal outcome, not an error", () => {
    expect(explainStatus("NO_TRADE").tone).toBe("neutral");
  });
});

describe("explainGate", () => {
  beforeEach(() => paperEnv());

  it("gives a plain-language label to every gate the risk engine emits", () => {
    const decision = evaluateRisk({ ...riskBase, intent: intent() });
    for (const check of decision.checks) {
      const label = explainGate(check.name);
      expect(label, `gate without a plain label: ${check.name}`).not.toBe(check.name.replace(/_/g, " "));
      expect(label).not.toMatch(/_/);
    }
  });

  it("has no stale labels for gates that no longer exist", () => {
    const live = new Set(evaluateRisk({ ...riskBase, intent: intent() }).checks.map((c) => c.name));
    expect(gateLabelCount()).toBe(live.size);
  });

  it("falls back to the raw name rather than inventing one", () => {
    expect(explainGate("some_future_gate")).toBe("some future gate");
  });
});

describe("plainDecision", () => {
  it("says what was bought, and what it can lose, on an approved trade", () => {
    const d = plainDecision(run({
      status: "TRADE_APPROVED",
      orderIntent: { ...intent(), maxLoss: 602, maxProfit: 898, strategy: "bull_call_debit_spread" },
    }));
    expect(d.headline).toMatch(/QQQ/);
    expect(d.soWhat).toMatch(/\$602/);
    expect(d.soWhat).toMatch(/\$898/);
    expect(d.tone).toBe("good");
  });

  it("names the failing checks in plain language on a rejection", () => {
    const d = plainDecision(run({
      status: "TRADE_REJECTED",
      risk: {
        approved: false,
        reasons: [],
        checks: [
          { name: "market_open", passed: false, blocking: true, detail: "" },
          { name: "quote_freshness", passed: false, blocking: true, detail: "" },
          { name: "reward_risk", passed: false, blocking: false, detail: "" },
        ],
      },
    }));
    expect(d.why).toMatch(/market is open/i);
    expect(d.why).toMatch(/prices are current/i);
    // Advisory checks are not blocking, so they must not be counted as reasons.
    expect(d.why).toMatch(/^2 safety checks/);
    expect(d.soWhat).toMatch(/No order was placed/);
  });

  it("distinguishes a closed market from a genuine lack of opportunity", () => {
    const closed = plainDecision(run({ message: "Market is closed, so no order was constructed." }));
    expect(closed.headline).toMatch(/closed/i);
    expect(closed.soWhat).toMatch(/when the market opens/);

    const quiet = plainDecision(run({ message: "No symbol cleared the entry gate." }));
    expect(quiet.headline).toMatch(/nothing worth trading/i);
    expect(quiet.why).toMatch(/QQQ came closest/);
  });

  it("reports how many symbols were checked", () => {
    expect(plainDecision(run()).why).toMatch(/All 2 stocks/);
  });

  it("falls back to the run's own message for statuses without a bespoke summary", () => {
    const d = plainDecision(run({ status: "ERROR", message: "Alpaca returned 502." }));
    expect(d.why).toBe("Alpaca returned 502.");
    expect(d.tone).toBe("bad");
  });
});

describe("GLOSSARY", () => {
  it("defines the terms the interface actually shows", () => {
    for (const key of [
      "variance-risk-premium", "implied-volatility", "realized-volatility", "bipower",
      "jump-fraction", "delta", "debit-spread", "max-loss", "breakeven", "paper-trading",
    ]) {
      expect(isTermKey(key), `missing glossary term: ${key}`).toBe(true);
    }
  });

  it("gives every term both a definition and a reason VolGuard cares", () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.term.length, key).toBeGreaterThan(0);
      expect(entry.plain.length, key).toBeGreaterThan(20);
      expect(entry.why.length, key).toBeGreaterThan(20);
    }
  });

  it("never defines a term using the term itself", () => {
    // "Implied volatility is the implied volatility of..." helps nobody.
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      const head = entry.term.replace(/\s*\(.*\)\s*/g, "").trim().toLowerCase();
      expect(entry.plain.toLowerCase().startsWith(head), `${key} defines itself`).toBe(false);
    }
  });

  it("rejects unknown term keys", () => {
    expect(isTermKey("not-a-term")).toBe(false);
  });
});

describe("briefDecision", () => {
  it("says the whole approved decision in a headline and one line", () => {
    const d = briefDecision(run({
      status: "TRADE_APPROVED",
      observation: { volatility: { varianceRiskPremium: -0.058 } } as never,
    }));
    expect(d.headline).toBe("QQQ — options look cheap");
    expect(d.line).toBe("Cheaper by 5.8 points than QQQ actually moves.");
    expect(d.tone).toBe("good");
  });

  it("stays terse: no line runs past a comfortable reading width", () => {
    const cases = [
      run({ status: "TRADE_APPROVED", observation: { volatility: { varianceRiskPremium: -0.058 } } as never }),
      run({ status: "NO_TRADE", message: "Market is closed, so no order was constructed." }),
      run({ status: "NO_TRADE", message: "No symbol cleared the entry gate." }),
      run({ status: "TRADE_REJECTED", risk: { approved: false, reasons: [], checks: [
        { name: "market_open", passed: false, blocking: true, detail: "" },
      ] } }),
    ];
    for (const r of cases) {
      const d = briefDecision(r);
      expect(d.headline.length, `headline too long: ${d.headline}`).toBeLessThanOrEqual(42);
      expect(d.line.length, `line too long: ${d.line}`).toBeLessThanOrEqual(90);
    }
  });

  it("counts only blocking failures on a rejection", () => {
    const d = briefDecision(run({
      status: "TRADE_REJECTED",
      risk: { approved: false, reasons: [], checks: [
        { name: "market_open", passed: false, blocking: true, detail: "" },
        { name: "quote_freshness", passed: false, blocking: true, detail: "" },
        { name: "reward_risk", passed: false, blocking: false, detail: "" },
      ] },
    }));
    expect(d.line).toMatch(/^2 safety checks failed/);
  });

  it("distinguishes a closed market from a quiet one", () => {
    expect(briefDecision(run({ message: "Market is closed, so..." })).headline).toBe("Market closed");
    expect(briefDecision(run({ message: "No symbol cleared." })).headline).toBe("Nothing worth buying");
  });

  it("uses no jargon in any headline", () => {
    const jargon = /\b(VRP|implied|realized|bipower|backwardation|delta|skew|convexity|debit)\b/i;
    for (const status of ["TRADE_APPROVED", "TRADE_REJECTED", "NO_TRADE", "ERROR"] as const) {
      expect(briefDecision(run({ status })).headline).not.toMatch(jargon);
    }
  });
});
