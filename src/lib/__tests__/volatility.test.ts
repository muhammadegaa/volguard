import { describe, expect, it } from "vitest";
import type { AlpacaBar } from "../types";
import {
  atmImpliedVol,
  bipowerVolatility,
  jumpFraction,
  parkinsonVolatility,
  parseOccSymbol,
  percentileRank,
  realizedVolatility,
  realizedVolRank,
  skew25,
  toChainRows,
  trendVsSma,
  forecastVolatility,
  buildVolatilityState,
} from "../volatility";
import { bars, chainRow, wanderingBars } from "./fixtures";

describe("realizedVolatility", () => {
  it("returns null until there are enough bars for the window", () => {
    expect(realizedVolatility(bars(5), 20)).toBeNull();
    expect(realizedVolatility(bars(21), 20)).not.toBeNull();
  });

  it("annualizes daily volatility by sqrt(252)", () => {
    // A perfectly alternating +/-1% series has a known daily standard deviation.
    const series = bars(60, 100, 0.01);
    const value = realizedVolatility(series, 20) as number;
    expect(value).toBeGreaterThan(0.1);
    expect(value).toBeLessThan(0.35);
  });

  it("scales with the size of the daily move", () => {
    const calm = realizedVolatility(bars(60, 100, 0.002), 20) as number;
    const wild = realizedVolatility(bars(60, 100, 0.02), 20) as number;
    expect(wild).toBeGreaterThan(calm * 5);
  });

  it("returns null rather than NaN when a close is non-positive", () => {
    const broken = bars(30);
    broken[10].c = 0;
    expect(realizedVolatility(broken, 20)).toBeNull();
  });
});

describe("bipowerVolatility and jumpFraction", () => {
  /** A calm series with one large gap inserted, mirroring an earnings move. */
  function withJump(size: number) {
    const series = bars(60, 100, 0.004);
    const at = series.length - 10;
    for (let i = at; i < series.length; i += 1) series[i].c *= 1 + size;
    return series;
  }

  it("tracks close-to-close volatility closely when there are no jumps", () => {
    const calm = bars(60, 100, 0.004);
    const rv = realizedVolatility(calm, 20) as number;
    const bv = bipowerVolatility(calm, 20) as number;
    expect(Math.abs(bv - rv) / rv).toBeLessThan(0.25);
    expect(jumpFraction(rv, bv) as number).toBeLessThan(0.2);
  });

  it("stays far below realized volatility when a single gap dominates the window", () => {
    const jumpy = withJump(0.15);
    const rv = realizedVolatility(jumpy, 20) as number;
    const bv = bipowerVolatility(jumpy, 20) as number;
    expect(bv).toBeLessThan(rv);
    expect(jumpFraction(rv, bv) as number).toBeGreaterThan(0.35);
  });

  it("reports a larger jump share for a larger gap", () => {
    const small = withJump(0.05);
    const large = withJump(0.25);
    const share = (series: ReturnType<typeof bars>) =>
      jumpFraction(realizedVolatility(series, 20), bipowerVolatility(series, 20)) as number;
    expect(share(large)).toBeGreaterThan(share(small));
  });

  it("returns null without enough bars", () => {
    expect(bipowerVolatility(bars(3), 20)).toBeNull();
  });

  it("bounds the jump share to 0..1 and returns null on missing inputs", () => {
    expect(jumpFraction(null, 0.2)).toBeNull();
    expect(jumpFraction(0.2, null)).toBeNull();
    expect(jumpFraction(0, 0.2)).toBeNull();
    // Bipower above realized means no jump signal, not a negative share.
    expect(jumpFraction(0.2, 0.3)).toBe(0);
  });
});

describe("parkinsonVolatility", () => {
  it("produces a positive annualized estimate from the high-low range", () => {
    const value = parkinsonVolatility(bars(40), 20);
    expect(value).toBeGreaterThan(0);
  });

  it("returns null when the window is not covered", () => {
    expect(parkinsonVolatility(bars(5), 20)).toBeNull();
  });
});

describe("realizedVolRank", () => {
  it("returns null without enough history to rank against", () => {
    expect(realizedVolRank(bars(25))).toBeNull();
  });

  it("bounds the rank to 0..1", () => {
    const rank = realizedVolRank(bars(200));
    expect(rank).not.toBeNull();
    expect(rank as number).toBeGreaterThanOrEqual(0);
    expect(rank as number).toBeLessThanOrEqual(1);
  });
});

describe("trendVsSma", () => {
  it("is positive when price closes above its moving average", () => {
    const rising = Array.from({ length: 25 }, (_, i) => ({
      t: "", o: 100 + i, h: 100 + i, l: 100 + i, c: 100 + i, v: 1,
    }));
    expect(trendVsSma(rising, 20) as number).toBeGreaterThan(0);
  });
});

describe("parseOccSymbol", () => {
  it("parses a real Alpaca contract symbol", () => {
    expect(parseOccSymbol("SPY260918C00767000")).toEqual({
      expiry: "2026-09-18",
      type: "call",
      strike: 767,
    });
  });

  it("parses puts and fractional strikes", () => {
    expect(parseOccSymbol("AAPL260918P00232500")).toEqual({
      expiry: "2026-09-18",
      type: "put",
      strike: 232.5,
    });
  });

  it("rejects anything that is not an OCC symbol", () => {
    expect(parseOccSymbol("SPY")).toBeNull();
    expect(parseOccSymbol("NOTACONTRACT")).toBeNull();
  });
});

describe("toChainRows", () => {
  it("maps the Alpaca snapshot shape including greeks and implied volatility", () => {
    const rows = toChainRows({
      SPY260918C00767000: {
        latestQuote: { bp: 14.01, ap: 14.25, bs: 40, as: 130, t: "2026-08-19T15:51:30Z" },
        greeks: { delta: 0.5887 },
        impliedVolatility: 0.1258,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ strike: 767, type: "call", delta: 0.5887, impliedVol: 0.1258 });
    expect(rows[0].mid).toBeCloseTo(14.13, 2);
  });

  it("leaves mid null when the quote is one-sided", () => {
    const rows = toChainRows({
      SPY260918C00767000: { latestQuote: { bp: 1 }, greeks: { delta: 0.5 }, impliedVolatility: 0.2 },
    });
    expect(rows[0].mid).toBeNull();
  });

  it("drops entries whose symbol is not a parseable contract", () => {
    expect(toChainRows({ GARBAGE: { impliedVolatility: 0.2 } })).toHaveLength(0);
  });
});

describe("atmImpliedVol", () => {
  it("interpolates between the deltas that bracket 0.50", () => {
    const rows = [
      chainRow({ symbol: "A", delta: 0.45, impliedVol: 0.10 }),
      chainRow({ symbol: "B", delta: 0.55, impliedVol: 0.20 }),
    ];
    expect(atmImpliedVol(rows) as number).toBeCloseTo(0.15, 6);
  });

  it("falls back to the nearest contract when nothing brackets 0.50", () => {
    const rows = [chainRow({ symbol: "A", delta: 0.2, impliedVol: 0.3 })];
    expect(atmImpliedVol(rows)).toBe(0.3);
  });

  it("returns null when no row carries implied volatility", () => {
    expect(atmImpliedVol([chainRow({ symbol: "A", delta: 0.5, impliedVol: null })])).toBeNull();
  });
});

describe("skew25", () => {
  it("measures 25-delta put IV minus 25-delta call IV", () => {
    const rows = [
      chainRow({ symbol: "P", type: "put", delta: -0.25, impliedVol: 0.28 }),
      chainRow({ symbol: "C", type: "call", delta: 0.25, impliedVol: 0.20 }),
    ];
    expect(skew25(rows) as number).toBeCloseTo(0.08, 6);
  });

  it("returns null when only one side of the chain is present", () => {
    expect(skew25([chainRow({ symbol: "C", type: "call", delta: 0.25, impliedVol: 0.2 })])).toBeNull();
  });
});

describe("percentileRank", () => {
  it("withholds a rank until the minimum sample count is reached", () => {
    expect(percentileRank([0.1, 0.2, 0.3], 20)).toBeNull();
  });

  it("ranks the newest observation within its own history", () => {
    const history = Array.from({ length: 21 }, (_, i) => i / 100);
    expect(percentileRank(history, 20)).toBe(1);
    expect(percentileRank([...history.slice(0, 20), -1], 20)).toBe(0);
  });
});

describe("forecastVolatility", () => {
  /** Bars whose volatility decays: violent early, calm recently — the regime that broke the old signal. */
  function decayingBars(count: number): ReturnType<typeof bars> {
    const out = [];
    let close = 100;
    for (let i = 0; i < count; i += 1) {
      // 4% daily swings for the first half, 0.4% for the second.
      const move = i < count / 2 ? 0.04 : 0.004;
      close = close * (1 + (i % 2 === 0 ? 1 : -1) * move);
      out.push({
        t: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
        o: close, h: close * 1.005, l: close * 0.995, c: close, v: 1_000_000,
      });
    }
    return out;
  }

  it("returns null only when there is no usable price history at all", () => {
    expect(forecastVolatility([], 30)).toBeNull();
    expect(forecastVolatility(bars(2), 30)).toBeNull();
  });

  it("degrades to the trailing estimate rather than fabricating a fit", () => {
    // Far too few bars to fit four parameters over a 22-day lag.
    const forecast = forecastVolatility(bars(40), 30);
    expect(forecast).not.toBeNull();
    expect(forecast!.source).toBe("trailing");
    expect(forecast!.rSquared).toBeNull();
    expect(forecast!.samples).toBeNull();
    expect(forecast!.value).toBeCloseTo(bipowerVolatility(bars(40), 20)!, 10);
  });

  it("refuses to fit a perfectly periodic series rather than inverting a singular matrix", () => {
    // bars() alternates by a fixed percentage, so every bipower term is identical and the
    // regressors carry no information. Falling back is the correct answer, not a failure.
    expect(forecastVolatility(bars(300), 30)!.source).toBe("trailing");
  });

  it("fits the regression when there is enough history, and says so", () => {
    const forecast = forecastVolatility(wanderingBars(300), 30);
    expect(forecast!.source).toBe("har");
    expect(forecast!.samples).toBeGreaterThanOrEqual(60);
    expect(forecast!.rSquared).not.toBeNull();
    expect(forecast!.horizonDays).toBe(30);
  });

  it("tracks the recent regime instead of a decayed one — the bug this exists to fix", () => {
    const series = decayingBars(300);
    const forecast = forecastVolatility(series, 14)!;
    const trailing = bipowerVolatility(series, 20)!;
    const recent = realizedVolatility(series, 10)!;

    // The trailing 20-day window still carries some of the violent first half; the forecast
    // should sit far closer to what the stock is actually doing now.
    expect(Math.abs(forecast.value - recent)).toBeLessThan(Math.abs(trailing - recent));
  });

  it("rejects an implausible extrapolation but still reports a real measurement", () => {
    const spiky = wanderingBars(300, 0.9);  // up to ~90% daily moves, but always positive
    const forecast = forecastVolatility(spiky, 30)!;
    // The fit cannot produce >300% annualized; if the underlying genuinely did that, the
    // honest trailing measurement is reported instead of a clamped fiction.
    expect(forecast.value).toBeGreaterThan(0);
    if (forecast.source === "har") expect(forecast.value).toBeLessThanOrEqual(3);
    else expect(forecast.value).toBeCloseTo(bipowerVolatility(spiky, 20)!, 10);
  });

  it("rounds the horizon and refuses a nonsensical one", () => {
    expect(forecastVolatility(wanderingBars(300), 13.6)!.horizonDays).toBe(14);
    expect(forecastVolatility(wanderingBars(300), 0)!.horizonDays).toBe(1);
    expect(forecastVolatility(wanderingBars(300), -5)!.horizonDays).toBe(1);
  });

  it("shrinks toward the trailing estimate when the fit explains little", () => {
    const series = wanderingBars(600);
    const forecast = forecastVolatility(series, 14)!;
    const trailing = bipowerVolatility(series, 20)!;
    expect(forecast.shrinkage).not.toBeNull();
    expect(forecast.shrinkage!).toBeGreaterThanOrEqual(0);
    expect(forecast.shrinkage!).toBeLessThanOrEqual(1);

    // A near-random walk carries little predictable structure, so the forecast should sit
    // close to the trailing estimate rather than wandering off toward the sample mean.
    if (forecast.shrinkage! > 0.8) {
      expect(Math.abs(forecast.value - trailing)).toBeLessThan(0.2 * trailing);
    }
  });

  it("reports no shrinkage weight on the fallback path", () => {
    expect(forecastVolatility(bars(40), 30)!.shrinkage).toBeNull();
  });

  it("gives a longer horizon its own forecast rather than reusing one number", () => {
    const short = forecastVolatility(decayingBars(300), 5)!;
    const long = forecastVolatility(decayingBars(300), 60)!;
    expect(short.horizonDays).not.toBe(long.horizonDays);
    expect(short.value).not.toBeCloseTo(long.value, 6);
  });
});

describe("the variance risk premium reconciles with what is displayed", () => {
  /**
   * The UI shows two volatility numbers side by side and a premium beneath them. If the
   * premium is not exactly their difference, a judge subtracting them gets a different
   * answer from the one on screen. That shipped once: the panels showed `bipowerVol20`
   * while the premium was computed against `forecastVol`.
   */
  function state(bars: AlpacaBar[], atmIv: number) {
    const rows = [
      chainRow({ symbol: "X260918C00100000", strike: 100, delta: 0.5, impliedVol: atmIv, bid: 1, ask: 1.1 }),
      chainRow({ symbol: "X260918P00100000", strike: 100, type: "put", delta: -0.5, impliedVol: atmIv, bid: 1, ask: 1.1 }),
    ];
    return buildVolatilityState({
      bars, targetRows: rows, frontRows: rows, backRows: [],
      ivHistory: [], minIvSamples: 20, horizonDays: 14,
    });
  }

  it("equals implied minus the forecast, which is the pair rendered together", () => {
    const v = state(wanderingBars(600), 0.30);
    expect(v.forecastVol).not.toBeNull();
    expect(v.varianceRiskPremium).not.toBeNull();
    expect(v.varianceRiskPremium!).toBeCloseTo(v.atmImpliedVol! - v.forecastVol!, 12);
  });

  it("does NOT equal implied minus trailing bipower — the pair that used to be rendered", () => {
    const v = state(wanderingBars(600), 0.30);
    // If these ever coincide the test proves nothing, so require them to differ first.
    expect(v.bipowerVol20).not.toBeCloseTo(v.forecastVol!, 4);
    expect(v.varianceRiskPremium!).not.toBeCloseTo(v.atmImpliedVol! - v.bipowerVol20!, 4);
  });

  it("keeps the pre-fix number available and correctly defined", () => {
    const v = state(wanderingBars(600), 0.30);
    expect(v.trailingVarianceRiskPremium!).toBeCloseTo(v.atmImpliedVol! - v.bipowerVol20!, 12);
  });

  it("reports the horizon and method alongside, so the number can be labelled honestly", () => {
    const v = state(wanderingBars(600), 0.30);
    expect(v.forecastHorizonDays).toBe(14);
    expect(["har", "trailing"]).toContain(v.forecastSource);
  });
});
