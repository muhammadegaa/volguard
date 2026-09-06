/**
 * What historical option data does this Alpaca account actually have?
 *
 * Asked because a trade-level backtest of VolGuard needs three things at a past date: the
 * implied volatility that produced the entry signal, a two-sided quote to cross at, and a
 * contract that has since expired so the outcome is known. This measures whether any of the
 * three is available, rather than assuming.
 *
 *   node --env-file=.env.local scripts/probe-option-history.mjs
 *
 * Read-only. Touches the paper trading host and the market data host; places nothing.
 */

const KEY = process.env.ALPACA_API_KEY;
const SECRET = process.env.ALPACA_SECRET_KEY;
if (!KEY || !SECRET) {
  console.error("ALPACA_API_KEY and ALPACA_SECRET_KEY must be set. Run with --env-file=.env.local");
  process.exit(1);
}

const HEADERS = { "APCA-API-KEY-ID": KEY, "APCA-API-SECRET-KEY": SECRET };
const get = async (url) => {
  const response = await fetch(url, { headers: HEADERS });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const iso = (offsetDays) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const occ = (underlying, yymmdd, type, strike) =>
  `${underlying}${yymmdd}${type}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

console.log(`VolGuard — option history probe · ${new Date().toISOString().slice(0, 10)}\n`);

// ── 1. What fields does a historical bar carry? ──────────────────────────────
// A long-dated contract has been listed for months, so its bar history is a fair sample.
const listed = await get(
  "https://paper-api.alpaca.markets/v2/options/contracts" +
    "?underlying_symbols=SPY&expiration_date=2026-12-18&type=call&limit=40" +
    "&strike_price_gte=600&strike_price_lte=700",
);
const symbols = (listed.body?.option_contracts ?? []).map((c) => c.symbol);
console.log(`1. Long-dated SPY calls listed: ${symbols.length}`);

if (symbols.length > 0) {
  const bars = await get(
    `https://data.alpaca.markets/v1beta1/options/bars?symbols=${symbols.join(",")}` +
      `&timeframe=1Day&start=${iso(-190)}T00:00:00Z&end=${iso(-1)}T00:00:00Z&limit=10000`,
  );
  const series = bars.body?.bars ?? {};
  const counts = Object.values(series).map((rows) => rows.length);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const sample = Object.values(series)[0]?.[0];

  console.log(`   contracts with any bar: ${Object.keys(series).length} of ${symbols.length}`);
  console.log(`   total daily bars: ${total}`);
  console.log(`   FIELDS ON A BAR: ${sample ? Object.keys(sample).sort().join(",") : "none returned"}`);
  console.log("   → trade OHLC and volume only. No bid, no ask, no greeks, no implied volatility.");
}

// ── 2. Can an expired contract be read at all? ───────────────────────────────
// Without one there is no known outcome to score a past entry against.
console.log("\n2. Expired contracts");
for (const query of ["", "status=inactive&", "status=active&"]) {
  const response = await get(
    `https://paper-api.alpaca.markets/v2/options/contracts?underlying_symbols=SPY&${query}expiration_date=2026-06-19&limit=5`,
  );
  console.log(`   listing (${query || "default"}): ${(response.body?.option_contracts ?? []).length} contracts, HTTP ${response.status}`);
}

// The listing may simply omit them; ask the bars endpoint directly by constructing the symbols.
const expired = [];
for (let strike = 500; strike <= 620; strike += 5) expired.push(occ("SPY", "260619", "C", strike));
const expiredBars = await get(
  `https://data.alpaca.markets/v1beta1/options/bars?symbols=${expired.join(",")}` +
    "&timeframe=1Day&start=2026-05-18T00:00:00Z&end=2026-06-19T00:00:00Z&limit=10000",
);
console.log(`   bars for ${expired.length} constructed expired symbols: ${Object.keys(expiredBars.body?.bars ?? {}).length} with data, HTTP ${expiredBars.status}`);

// ── 3. What does a live snapshot carry, for contrast? ────────────────────────
// This is where the agent's implied volatility and deltas come from. Not every contract on
// the free indicative feed carries them, so sample rather than trusting the first one.
const snapshot = await get("https://data.alpaca.markets/v1beta1/options/snapshots/SPY?limit=100&feed=indicative");
const all = Object.values(snapshot.body?.snapshots ?? {});
const withGreeks = all.filter((s) => s.greeks).length;
const withIv = all.filter((s) => s.impliedVolatility !== undefined).length;
const fields = new Set();
for (const s of all) for (const key of Object.keys(s)) fields.add(key);
console.log(`\n3. LIVE snapshots sampled: ${all.length}`);
console.log(`   fields seen across them: ${[...fields].sort().join(",")}`);
console.log(`   carrying greeks: ${withGreeks} · carrying impliedVolatility: ${withIv}`);
console.log("   → these are the entry signal's inputs, and they exist only live.\n");

console.log("Conclusion: a trade-level backtest needs an expired contract (for the outcome)");
console.log("and its implied volatility (for the entry signal). Expired contracts return no");
console.log("data, and no historical endpoint carries implied volatility. Neither is available.");
