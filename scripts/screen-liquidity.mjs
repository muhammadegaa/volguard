/**
 * Options-liquidity screen for the tradable universe.
 *
 * VolGuard rejects any leg whose relative bid-ask spread exceeds VOLGUARD_MAX_SPREAD_PERCENT
 * (8% by default), so a symbol whose options rarely clear that gate is not tradable however
 * famous it is. This measures, per candidate, the share of near-the-money contracts that
 * actually pass — on the same free `indicative` feed the agent uses.
 *
 *   node --env-file=.env.local scripts/screen-liquidity.mjs
 */
const H = { "APCA-API-KEY-ID": process.env.ALPACA_API_KEY, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY };
const D = "https://data.alpaca.markets";
const iso = (d) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0,10); };

const CANDIDATES = `SPY QQQ IWM DIA GLD SLV TLT XLF XLE SMH
AAPL MSFT NVDA AMZN GOOGL META TSLA AVGO
AMD INTC MU QCOM TSM ARM
NFLX DIS CRM ORCL ADBE UBER ABNB
JPM BAC GS WFC C
XOM CVX OXY
WMT COST HD NKE SBUX
PFE JNJ UNH LLY MRK
BA CAT GE DE
COIN PLTR SOFI HOOD MSTR RIVN LCID SNAP`.split(/\s+/).filter(Boolean);

async function assess(sym) {
  try {
    const s = await (await fetch(`${D}/v2/stocks/${sym}/snapshot?feed=iex`, { headers: H })).json();
    const price = s?.latestTrade?.p ?? s?.dailyBar?.c ?? 0;
    if (!(price > 0)) return { sym, ok: false, why: "no price" };
    const q = new URLSearchParams({
      feed: "indicative", limit: "500",
      strike_price_gte: String(price * 0.85), strike_price_lte: String(price * 1.15),
      expiration_date_gte: iso(7), expiration_date_lte: iso(45),
    });
    const c = await (await fetch(`${D}/v1beta1/options/snapshots/${sym}?${q}`, { headers: H })).json();
    const snaps = Object.entries(c.snapshots ?? {});
    if (snaps.length === 0) return { sym, ok: false, why: "no chain" };

    // Relative spread on contracts near the money, which is where we actually trade.
    const spreads = [];
    let withGreeks = 0;
    for (const [, v] of snaps) {
      const bid = v?.latestQuote?.bp, ask = v?.latestQuote?.ap;
      const delta = v?.greeks?.delta;
      if (typeof delta === "number") withGreeks += 1;
      if (typeof bid === "number" && typeof ask === "number" && bid > 0 && ask >= bid) {
        const mid = (bid + ask) / 2;
        const absD = Math.abs(delta ?? 0.5);
        if (mid > 0 && absD > 0.15 && absD < 0.7) spreads.push((ask - bid) / mid);
      }
    }
    if (spreads.length === 0) return { sym, ok: false, why: "no two-sided quotes", contracts: snaps.length };
    spreads.sort((a, b) => a - b);
    const median = spreads[Math.floor(spreads.length / 2)];
    const passRate = spreads.filter((x) => x <= 0.08).length / spreads.length;
    return { sym, ok: true, price, contracts: snaps.length, greeks: withGreeks, median, passRate, n: spreads.length };
  } catch (e) { return { sym, ok: false, why: e.message.slice(0, 30) }; }
}

const out = [];
for (let i = 0; i < CANDIDATES.length; i += 10) {
  out.push(...await Promise.all(CANDIDATES.slice(i, i + 10).map(assess)));
}
const good = out.filter(r => r.ok).sort((a, b) => b.passRate - a.passRate);
console.log("sym    price   contracts  medSpread  %<=8%  tradable");
for (const r of good) {
  console.log(`${r.sym.padEnd(6)}${r.price.toFixed(0).padStart(7)}${String(r.contracts).padStart(10)}` +
    `${(r.median*100).toFixed(1).padStart(10)}%${(r.passRate*100).toFixed(0).padStart(7)}%   ${r.passRate >= 0.5 ? "YES" : ""}`);
}
console.log("\nfailed:", out.filter(r => !r.ok).map(r => `${r.sym}(${r.why})`).join(" ") || "none");
console.log(`\n${good.filter(r => r.passRate >= 0.5).length} of ${CANDIDATES.length} clear the 8% spread gate on a majority of near-the-money contracts.`);
console.log("SHORTLIST:", good.filter(r => r.passRate >= 0.5).map(r => r.sym).join(","));
