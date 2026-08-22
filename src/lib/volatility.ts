import type { AlpacaBar, AlpacaOptionSnapshot, VolatilityState } from "./types";

const TRADING_DAYS = 252;

/** Annualized close-to-close volatility over the most recent `window` returns. */
export function realizedVolatility(bars: AlpacaBar[], window: number): number | null {
  if (bars.length < window + 1) return null;
  const slice = bars.slice(-(window + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1].c;
    const curr = slice[i].c;
    if (!(prev > 0 && curr > 0)) return null;
    returns.push(Math.log(curr / prev));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS);
}

function logReturns(bars: AlpacaBar[], window: number): number[] | null {
  if (bars.length < window + 1) return null;
  const slice = bars.slice(-(window + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1].c;
    const curr = slice[i].c;
    if (!(prev > 0 && curr > 0)) return null;
    returns.push(Math.log(curr / prev));
  }
  return returns.length >= 2 ? returns : null;
}

/**
 * Bipower variation (Barndorff-Nielsen & Shephard): the jump-robust cousin of realized
 * volatility. It averages the product of *adjacent* absolute returns rather than squaring
 * each return, so a single large gap inflates only two cross-terms instead of dominating
 * the sum outright, and the estimate converges to volatility excluding jumps.
 *
 * This matters because a stock that gapped on earnings three weeks ago has a huge trailing
 * realized volatility that says nothing about what it will deliver from here. Pricing
 * implied volatility against that number makes options look far cheaper than they are.
 */
export function bipowerVolatility(bars: AlpacaBar[], window: number): number | null {
  const returns = logReturns(bars, window);
  if (!returns || returns.length < 3) return null;
  let sum = 0;
  for (let i = 1; i < returns.length; i += 1) {
    sum += Math.abs(returns[i]) * Math.abs(returns[i - 1]);
  }
  return Math.sqrt((Math.PI / 2) * (sum / (returns.length - 1)) * TRADING_DAYS);
}

/**
 * Share of realized variance attributable to jumps, 0..1. Near zero means the movement was
 * continuous and the realized number is a fair baseline; high means one or two gaps carry
 * it, and the "cheapness" they imply is backward-looking.
 */
export function jumpFraction(realized: number | null, bipower: number | null): number | null {
  if (realized === null || bipower === null || !(realized > 0)) return null;
  return Math.max(0, Math.min(1, 1 - (bipower * bipower) / (realized * realized)));
}

/**
 * Per-day jump-robust *variance* contributions, annualized: (π/2)·|r_t|·|r_{t-1}|·252.
 * Unlike r², one gap cannot dominate it. Aligned to returns[1..n-1].
 */
function dailyBipowerVariance(bars: AlpacaBar[]): number[] | null {
  const returns = logReturns(bars, bars.length - 1);
  if (!returns || returns.length < 3) return null;
  const series: number[] = [];
  for (let i = 1; i < returns.length; i += 1) {
    series.push((Math.PI / 2) * Math.abs(returns[i]) * Math.abs(returns[i - 1]) * TRADING_DAYS);
  }
  return series;
}

/**
 * Annualized volatility over a window of daily variance contributions: √(mean variance).
 *
 * Every quantity in the regression — each regressor and the target — is built with this
 * one function, and that consistency is load-bearing. Mixing `mean(√v)` with `√(mean v)`
 * silently injects a Jensen bias: an earlier version of this code did exactly that and
 * under-forecast by 4 to 6 volatility points, which the walk-forward test caught.
 */
function windowVol(variances: number[], from: number, to: number): number {
  const slice = variances.slice(from, to);
  return Math.sqrt(slice.reduce((sum, v) => sum + v, 0) / slice.length);
}

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Solve a small symmetric positive-definite system by Gaussian elimination with partial
 * pivoting. Returns null when the matrix is too ill-conditioned to trust, which is the
 * honest answer for a degenerate design matrix — a silently garbage coefficient vector
 * would produce a confident forecast built on nothing.
 */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  const scale = Math.max(...m.flat().map(Math.abs));
  if (!Number.isFinite(scale) || scale === 0) return null;

  for (let col = 0; col < n; col += 1) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivotRow][col])) pivotRow = row;
    }
    if (Math.abs(m[pivotRow][col]) < 1e-12 * scale) return null;
    [m[col], m[pivotRow]] = [m[pivotRow], m[col]];

    for (let row = col + 1; row < n; row += 1) {
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k += 1) sum -= m[row][k] * x[k];
    x[row] = sum / m[row][row];
  }
  return x.every(Number.isFinite) ? x : null;
}

export interface VolatilityForecast {
  /** Annualized volatility expected over the next `horizonDays`. */
  value: number;
  /** `har` when a regression was fit and trusted; `trailing` when it degraded. */
  source: "har" | "trailing";
  horizonDays: number;
  /**
   * In-sample R² of the fit. Null on the fallback path. This is a diagnostic, NOT evidence
   * of skill — the out-of-sample evidence lives in docs/evidence/forecast-validation.md.
   */
  rSquared: number | null;
  /** Observations the regression was fit on. Null on the fallback path. */
  samples: number | null;
  /**
   * Weight placed on the trailing estimate, 0..1. A weak fit predicts close to the
   * unconditional mean, which is the stale behaviour this exists to avoid, so the forecast
   * is shrunk toward the trailing estimator in proportion to how little it explains.
   * Measured: shrinkage beat the raw fit at every horizon and every training window tested.
   */
  shrinkage: number | null;
}

/** Fit quality at which the regression is trusted outright. Chosen by walk-forward, not taste. */
const SHRINK_FULL_TRUST_R2 = 0.25;

const HAR_MIN_SAMPLES = 60;
const HAR_WEEK = 5;
const HAR_MONTH = 22;

/**
 * Forecast realized volatility over the option's own horizon, using HAR-RV
 * (Corsi 2009): a regression of future variance on its daily, weekly and monthly
 * components, fit on the symbol's own history.
 *
 * This exists because comparing a *forward* 30-day implied volatility against a *backward*
 * 20-day realized one is not a like-for-like comparison, and the mismatch is not academic.
 * Measured across the watchlist on 2026-08-20, every symbol's 10-day realized vol sat far
 * below its 20-day: the trailing window was still carrying a volatility episode that had
 * already decayed, so the engine read "options are cheap" on five of six names when the
 * variance risk premium is positive most of the time. Bipower strips jumps but not a
 * genuinely elevated stretch sitting in the older half of the window; a forecast that
 * weights recent days does.
 *
 * Returns null only when there is not enough price history to say anything at all.
 */
export function forecastVolatility(bars: AlpacaBar[], horizonDays: number): VolatilityForecast | null {
  const horizon = Math.max(1, Math.round(horizonDays));
  const trailing = bipowerVolatility(bars, 20);
  const fallback: VolatilityForecast | null = trailing === null
    ? null
    : { value: trailing, source: "trailing", horizonDays: horizon, rSquared: null, samples: null, shrinkage: null };

  const bp = dailyBipowerVariance(bars);
  if (!bp) return fallback;

  // Each row needs a full monthly lag behind it and `horizon` days of realised future ahead.
  const first = HAR_MONTH - 1;
  const last = bp.length - 1 - horizon;
  if (last - first + 1 < HAR_MIN_SAMPLES) return fallback;

  const rows: number[][] = [];
  const targets: number[] = [];
  for (let t = first; t <= last; t += 1) {
    rows.push([
      1,
      windowVol(bp, t, t + 1),
      windowVol(bp, t - HAR_WEEK + 1, t + 1),
      windowVol(bp, t - HAR_MONTH + 1, t + 1),
    ]);
    // The target is realized volatility over the horizon, measured exactly as the live
    // comparison measures it.
    targets.push(windowVol(bp, t + 1, t + 1 + horizon));
  }

  // Normal equations: (XᵀX)β = Xᵀy. Four parameters, so this is cheap and exact enough.
  const k = 4;
  const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < rows.length; i += 1) {
    for (let a = 0; a < k; a += 1) {
      xty[a] += rows[i][a] * targets[i];
      for (let b = 0; b < k; b += 1) xtx[a][b] += rows[i][a] * rows[i][b];
    }
  }

  const beta = solveLinearSystem(xtx, xty);
  if (!beta) return fallback;

  const latest = [
    1,
    windowVol(bp, bp.length - 1, bp.length),
    windowVol(bp, bp.length - HAR_WEEK, bp.length),
    windowVol(bp, bp.length - HAR_MONTH, bp.length),
  ];
  // The regression is already in volatility units, so the prediction needs no transform.
  const value = latest.reduce((sum, x, i) => sum + x * beta[i], 0);

  // A regression can produce a confident number from garbage coefficients, so an
  // extrapolation outside a plausible band is treated as a failed fit. The trailing
  // fallback is deliberately not clamped the same way: it is a direct measurement, and a
  // stock that really did move 40% a day has a real volatility of 800%, not of 300%.
  if (!Number.isFinite(value) || value < 0.01 || value > 3) return fallback;

  const yMean = mean(targets);
  const ssTot = targets.reduce((sum, y) => sum + (y - yMean) ** 2, 0);
  const ssRes = targets.reduce((sum, y, i) => {
    const fitted = rows[i].reduce((acc, x, j) => acc + x * beta[j], 0);
    return sum + (y - fitted) ** 2;
  }, 0);
  const rSquared = ssTot > 0 ? Number((1 - ssRes / ssTot).toFixed(4)) : null;

  // Shrink toward the trailing estimate by how little the fit explains.
  const trust = rSquared === null ? 0 : Math.max(0, Math.min(1, rSquared / SHRINK_FULL_TRUST_R2));
  const blended = trailing === null ? value : trust * value + (1 - trust) * trailing;

  return {
    value: blended,
    source: "har",
    horizonDays: horizon,
    rSquared,
    samples: rows.length,
    shrinkage: trailing === null ? 0 : Number((1 - trust).toFixed(3)),
  };
}

/**
 * Parkinson high-low estimator. Uses the intraday range rather than only the close, so it
 * reacts to a volatile session that happens to close flat.
 */
export function parkinsonVolatility(bars: AlpacaBar[], window: number): number | null {
  if (bars.length < window) return null;
  const slice = bars.slice(-window);
  let sum = 0;
  for (const bar of slice) {
    if (!(bar.h > 0 && bar.l > 0)) return null;
    sum += Math.log(bar.h / bar.l) ** 2;
  }
  return Math.sqrt((sum / slice.length) / (4 * Math.log(2))) * Math.sqrt(TRADING_DAYS);
}

/**
 * Where the latest 20-day realized vol sits inside its own trailing range, 0..1.
 * This is a realized-vol rank. It is not IV rank and is never labelled as one.
 */
export function realizedVolRank(bars: AlpacaBar[], window = 20, lookback = 252): number | null {
  if (bars.length < window + 21) return null;
  const series: number[] = [];
  const start = Math.max(window + 1, bars.length - lookback);
  for (let end = start; end <= bars.length; end += 1) {
    const value = realizedVolatility(bars.slice(0, end), window);
    if (value !== null) series.push(value);
  }
  if (series.length < 20) return null;
  const current = series[series.length - 1];
  const min = Math.min(...series);
  const max = Math.max(...series);
  if (!(max > min)) return null;
  return (current - min) / (max - min);
}

/** Close vs the 20-day simple moving average, as a fraction. */
export function trendVsSma(bars: AlpacaBar[], window = 20): number | null {
  if (bars.length < window) return null;
  const slice = bars.slice(-window);
  const sma = slice.reduce((sum, bar) => sum + bar.c, 0) / slice.length;
  if (!(sma > 0)) return null;
  return slice[slice.length - 1].c / sma - 1;
}

export interface ChainRow {
  symbol: string;
  strike: number;
  expiry: string;
  type: "call" | "put";
  delta: number | null;
  impliedVol: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  bidSize: number | null;
  askSize: number | null;
  quoteTime: string | null;
}

const OCC = /^(?<root>[A-Z]+)(?<yy>\d{2})(?<mm>\d{2})(?<dd>\d{2})(?<cp>[CP])(?<strike>\d{8})$/;

/** Parse an OCC-21 contract symbol, e.g. SPY260918C00767000. */
export function parseOccSymbol(symbol: string): { expiry: string; type: "call" | "put"; strike: number } | null {
  const match = OCC.exec(symbol);
  if (!match?.groups) return null;
  const { yy, mm, dd, cp, strike } = match.groups;
  return {
    expiry: `20${yy}-${mm}-${dd}`,
    type: cp === "C" ? "call" : "put",
    strike: Number(strike) / 1000,
  };
}

export function toChainRows(snapshots: Record<string, AlpacaOptionSnapshot>): ChainRow[] {
  return Object.entries(snapshots).flatMap(([symbol, snapshot]) => {
    const parsed = parseOccSymbol(symbol);
    if (!parsed) return [];
    const quote = snapshot.latestQuote;
    const bid = typeof quote?.bp === "number" ? quote.bp : null;
    const ask = typeof quote?.ap === "number" ? quote.ap : null;
    return [{
      symbol,
      strike: parsed.strike,
      expiry: parsed.expiry,
      type: parsed.type,
      delta: typeof snapshot.greeks?.delta === "number" ? snapshot.greeks.delta : null,
      impliedVol: typeof snapshot.impliedVolatility === "number" ? snapshot.impliedVolatility : null,
      bid,
      ask,
      mid: bid !== null && ask !== null && ask >= bid ? (bid + ask) / 2 : null,
      bidSize: typeof quote?.bs === "number" ? quote.bs : null,
      askSize: typeof quote?.as === "number" ? quote.as : null,
      quoteTime: quote?.t ?? null,
    }];
  });
}

/**
 * ATM implied volatility, linearly interpolated between the two rows whose |delta|
 * brackets 0.50. Falls back to the single closest row when only one side exists.
 */
export function atmImpliedVol(rows: ChainRow[]): number | null {
  const usable = rows.filter((row) => row.delta !== null && row.impliedVol !== null && row.impliedVol > 0);
  if (usable.length === 0) return null;
  const scored = usable
    .map((row) => ({ row, absDelta: Math.abs(row.delta as number) }))
    .sort((a, b) => Math.abs(a.absDelta - 0.5) - Math.abs(b.absDelta - 0.5));
  const nearest = scored[0];
  const opposite = scored.find((item) => (item.absDelta - 0.5) * (nearest.absDelta - 0.5) < 0);
  if (!opposite || nearest.absDelta === opposite.absDelta) return nearest.row.impliedVol;
  const weight = (0.5 - nearest.absDelta) / (opposite.absDelta - nearest.absDelta);
  return (nearest.row.impliedVol as number) + weight * ((opposite.row.impliedVol as number) - (nearest.row.impliedVol as number));
}

/** 25-delta put IV minus 25-delta call IV. Positive means downside protection is bid up. */
export function skew25(rows: ChainRow[]): number | null {
  const pick = (type: "call" | "put") => {
    const candidates = rows.filter(
      (row) => row.type === type && row.delta !== null && row.impliedVol !== null && row.impliedVol > 0,
    );
    if (candidates.length === 0) return null;
    return candidates.sort(
      (a, b) => Math.abs(Math.abs(a.delta as number) - 0.25) - Math.abs(Math.abs(b.delta as number) - 0.25),
    )[0].impliedVol;
  };
  const put = pick("put");
  const call = pick("call");
  return put !== null && call !== null ? put - call : null;
}

export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Percentile rank of the newest sample within its own history, 0..1.
 * Returns null until `minSamples` observations exist, rather than inventing a rank.
 */
export function percentileRank(history: number[], minSamples: number): number | null {
  if (history.length < minSamples) return null;
  const current = history[history.length - 1];
  const below = history.filter((value) => value < current).length;
  return below / (history.length - 1);
}

export function buildVolatilityState(input: {
  bars: AlpacaBar[];
  targetRows: ChainRow[];
  frontRows: ChainRow[];
  backRows: ChainRow[];
  ivHistory: number[];
  minIvSamples: number;
  /** Days to the expiry actually being traded. The forecast is made over this horizon. */
  horizonDays: number;
}): VolatilityState {
  const rv20 = realizedVolatility(input.bars, 20);
  const bv20 = bipowerVolatility(input.bars, 20);
  const forecast = forecastVolatility(input.bars, input.horizonDays);
  const atmIv = atmImpliedVol(input.targetRows);
  const frontIv = atmImpliedVol(input.frontRows);
  const backIv = atmImpliedVol(input.backRows);
  const history = atmIv !== null ? [...input.ivHistory, atmIv] : input.ivHistory;

  return {
    realizedVol20: rv20,
    realizedVol10: realizedVolatility(input.bars, 10),
    realizedVol5: realizedVolatility(input.bars, 5),
    bipowerVol20: bv20,
    jumpFraction: jumpFraction(rv20, bv20),
    parkinsonVol20: parkinsonVolatility(input.bars, 20),
    realizedVolRank: realizedVolRank(input.bars),
    atmImpliedVol: atmIv,
    frontImpliedVol: frontIv,
    backImpliedVol: backIv,
    termSlope: frontIv !== null && backIv !== null ? backIv - frontIv : null,
    forecastVol: forecast?.value ?? null,
    forecastSource: forecast?.source ?? null,
    forecastHorizonDays: forecast?.horizonDays ?? null,
    forecastR2: forecast?.rSquared ?? null,
    // Implied vol is forward-looking over the traded expiry, so it is priced against a
    // forecast over that same horizon rather than against a trailing window. See
    // `forecastVolatility` for why the trailing comparison was mis-signing the premium.
    varianceRiskPremium: atmIv !== null && forecast ? atmIv - forecast.value : null,
    trailingVarianceRiskPremium: atmIv !== null && bv20 !== null ? atmIv - bv20 : null,
    skew25: skew25(input.targetRows),
    impliedVolRank: percentileRank(history, input.minIvSamples),
    ivSamples: history.length,
  };
}
