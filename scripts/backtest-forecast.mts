/**
 * Walk-forward validation of the volatility forecast.
 *
 * Answers one question: does the HAR-RV forecast predict the next `h` days of realized
 * volatility better than the trailing estimators it replaced? This validates the FORECAST,
 * not trading P&L — no option prices are involved.
 *
 * Strictly out-of-sample: at every cutoff `t` the model sees bars[0..t] only, and is scored
 * against realized volatility over t+1..t+h, which it has never seen.
 *
 *   node --env-file=.env.local scripts/backtest-forecast.mts
 */
import { forecastVolatility, realizedVolatility, bipowerVolatility } from "../src/lib/volatility.ts";
import type { AlpacaBar } from "../src/lib/types.ts";

const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_SECRET_KEY;
if (!KEY || !SECRET) {
  console.error("ALPACA_API_KEY and ALPACA_SECRET_KEY must be set. Run with --env-file=.env.local");
  process.exit(1);
}

const SYMBOLS = (process.env.VOLGUARD_SYMBOLS ?? "SPY,QQQ,IWM,AAPL,MSFT,NVDA").split(",").map((s) => s.trim());
const HORIZONS = [7, 14, 30];
const MIN_TRAIN = 300;
const STEP = 3;

async function fetchBars(symbol: string): Promise<AlpacaBar[]> {
  const start = new Date();
  start.setUTCFullYear(start.getUTCFullYear() - 3);
  const query = new URLSearchParams({
    timeframe: "1Day",
    limit: "10000",
    adjustment: "split",
    feed: process.env.ALPACA_STOCK_FEED ?? "iex",
    start: start.toISOString().slice(0, 10),
  });
  const response = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/bars?${query}`, {
    headers: { "APCA-API-KEY-ID": KEY!, "APCA-API-SECRET-KEY": SECRET! },
  });
  if (!response.ok) throw new Error(`${symbol}: ${response.status}`);
  return ((await response.json()) as { bars?: AlpacaBar[] }).bars ?? [];
}

interface Scored { predicted: number; actual: number }

function metrics(pairs: Scored[]) {
  const n = pairs.length;
  if (n < 2) return null;
  const errors = pairs.map((p) => p.predicted - p.actual);
  const rmse = Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / n);
  const mae = errors.reduce((s, e) => s + Math.abs(e), 0) / n;
  const bias = errors.reduce((s, e) => s + e, 0) / n;

  // Mincer–Zarnowitz: regress actual on predicted. R² is the share of realized variation
  // the forecast explains; a forecast with no information scores ~0.
  const mx = pairs.reduce((s, p) => s + p.predicted, 0) / n;
  const my = pairs.reduce((s, p) => s + p.actual, 0) / n;
  const sxy = pairs.reduce((s, p) => s + (p.predicted - mx) * (p.actual - my), 0);
  const sxx = pairs.reduce((s, p) => s + (p.predicted - mx) ** 2, 0);
  const syy = pairs.reduce((s, p) => s + (p.actual - my) ** 2, 0);
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;

  return { n, rmse, mae, bias, r2 };
}

const results: Record<number, Record<string, Scored[]>> = {};
const TRAIN_CAPS = [260, 520, 1000];  // 260 is what production currently fetches.
for (const h of HORIZONS) {
  results[h] = { bipower20: [], realized20: [] };
  for (const cap of TRAIN_CAPS) results[h][`har${cap}`] = [];
}

let harFits = 0;
let harFallbacks = 0;

for (const symbol of SYMBOLS) {
  const bars = await fetchBars(symbol);
  process.stdout.write(`${symbol}: ${bars.length} bars\n`);

  for (const h of HORIZONS) {
    for (let t = MIN_TRAIN; t + h < bars.length; t += STEP) {
      const train = bars.slice(0, t + 1);
      // Realized volatility over the h sessions the model has not seen.
      const actual = realizedVolatility(bars.slice(0, t + 1 + h), h);
      if (actual === null || !(actual > 0)) continue;

      const bp20 = bipowerVolatility(train, 20);
      const rv20 = realizedVolatility(train, 20);

      // The decisive comparison: how much history the fit is allowed to see. Production
      // currently fetches 260 bars, so a result measured on 3 years does not describe it.
      for (const cap of TRAIN_CAPS) {
        const forecast = forecastVolatility(train.slice(-cap), h);
        if (!forecast) continue;
        if (forecast.source === "har") harFits += 1;
        else harFallbacks += 1;
        // forecastVolatility already shrinks toward the trailing estimate by fit quality;
        // applying it again here would measure a model that does not ship.
        results[h][`har${cap}`].push({ predicted: forecast.value, actual });
      }
      if (bp20 !== null) results[h].bipower20.push({ predicted: bp20, actual });
      if (rv20 !== null) results[h].realized20.push({ predicted: rv20, actual });
    }
  }
}

const pct = (v: number) => (v * 100).toFixed(2).padStart(7);
console.log(`\nHAR fits: ${harFits}  ·  fell back to trailing: ${harFallbacks}`);
console.log("\nOut-of-sample forecast accuracy (annualized vol points; lower RMSE/MAE better, higher R² better)\n");

let harWins = 0;
let comparisons = 0;
for (const h of HORIZONS) {
  console.log(`horizon ${h} sessions`);
  console.log("  method        n     RMSE      MAE     bias       R²");
  const scores: Record<string, ReturnType<typeof metrics>> = {};
  for (const method of [...TRAIN_CAPS.map((c) => `har${c}`), "bipower20", "realized20"]) {
    const m = metrics(results[h][method]);
    scores[method] = m;
    if (!m) { console.log(`  ${method.padEnd(11)} insufficient samples`); continue; }
    console.log(`  ${method.padEnd(11)}${String(m.n).padStart(5)}  ${pct(m.rmse)}  ${pct(m.mae)}  ${pct(m.bias)}   ${m.r2.toFixed(3)}`);
  }
  if (scores.har520 && scores.bipower20) {
    comparisons += 1;
    if (scores.har520.rmse < scores.bipower20.rmse) harWins += 1;
    const delta = ((scores.bipower20.rmse - scores.har520.rmse) / scores.bipower20.rmse) * 100;
    console.log(`  → HAR(520) RMSE is ${delta >= 0 ? delta.toFixed(1) + "% BETTER" : Math.abs(delta).toFixed(1) + "% WORSE"} than trailing bipower20\n`);
  }
}

console.log(`VERDICT: HAR beat trailing bipower on ${harWins} of ${comparisons} horizons by RMSE.`);
console.log(harWins === comparisons
  ? "The forecast is an improvement on every horizon tested."
  : harWins === 0
    ? "The forecast is NOT an improvement. Do not ship it on this evidence."
    : "Mixed. Ship only the horizons where it wins, and say which.");
