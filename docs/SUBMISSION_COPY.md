# VolGuard — submission copy

Ready-to-paste text for the lablab.ai submission form. Placeholders in `«guillemets»` must
be filled once the external assets exist.

---

## Title

```
VolGuard
```

## Tagline

```
Buy movement only when it's cheap.
```

Alternates, if the form wants something more literal:

- `An options agent that trades the price of movement, not the direction of it.`
- `The autonomous options agent whose most common answer is no.`

---

## Short description (≈ 280 characters)

```
VolGuard is an autonomous options agent for the volatility track. It prices implied
volatility against what a stock actually delivers, buys defined-risk vertical spreads only when
premium is genuinely cheap, and abstains — with a stated reason — every other time.
```

## Long description

```
Most trading agents predict direction. Direction is close to a coin flip, and an options
position that is really a levered directional bet is a stock signal wearing an options
costume. VolGuard trades the quantity that options actually price: the variance risk
premium, the gap between what the market charges for future movement and what the underlying
has actually delivered.

Every run, VolGuard scans its watchlist through Alpaca and builds a full volatility picture
per symbol: realized volatility over 20/10/5 days, at-the-money implied volatility
interpolated from Alpaca's option chain snapshots (which serve real greeks and IV), the
term-structure slope between the front and back expiries, 25-delta skew, and a realized-vol
rank. Because Alpaca serves no implied-volatility history, VolGuard accumulates its own
daily observation per symbol and honestly reports "building (n obs)" until it has enough to
rank — it never invents a number it does not have.

The signal is deliberately jump-robust. Raw realized volatility is dominated by gaps that
have already happened: on 2026-08-19 MSFT showed 57.7% realized against 24.7% implied, an
apparently enormous mispricing that was entirely one +15.5% earnings gap three weeks earlier.
VolGuard uses bipower variation, the Barndorff-Nielsen & Shephard
jump-robust estimator, and abstains outright when more than 35% of realized variance came
from jumps. MSFT is correctly rejected as jump-contaminated rather than ranked first.

Event risk is scored with a weighted taxonomy over Alpaca news — earnings, regulatory,
M&A, macro, policy, legal, leadership, ratings — discounted by recency and by whether a
headline actually names the symbol, plus corporate actions in the holding window. Headline
count is deliberately not the signal: twenty analyst notes are not the same risk as one FDA
decision. When a known binary catalyst sits inside the window, expensive premium is
compensation rather than mispricing, and VolGuard stands aside.

When a setup does qualify, the agent goes to the live chain, targets delta 0.55 long and
0.27 short at roughly 30 days, searches candidate strike pairs for the best reward-for-risk
that clears every liquidity gate, and builds a defined-risk vertical spread. Maximum loss is the
premium paid: not a stop that can gap through, but arithmetic that is known before the order
exists. Thirty deterministic checks then run, twenty-seven of which can block — quote
freshness, relative spread, displayed depth, per-trade loss cap, equity percentage, daily
loss budget, portfolio exposure, open position count, buying power, duplicate client order
ID, and more. Claude may narrate and
stress-test the decision, and may veto it down to no-trade, but it can never change the
symbol, change the strategy, or turn an abstain into a trade. Only the deterministic engine
can approve.

A qualifying setup is not the only one considered. The agent ranks every candidate that
cleared the entry gate and works down the list spending a single risk budget, carrying the
remaining daily loss allowance, the open position count and the open risk as it goes, so each
position is sized against what the earlier ones left. That matters because every money gate
compares one order against one limit: measured against the same starting state, several
orders each pass while the portfolio breaches all of them together.

Every run also reviews open positions — first, and independently of whether anything new
qualifies — and exits on whichever comes first: +50% of maximum profit, -50% of premium paid,
or seven days to expiry, before gamma and pin risk dominate. A spread closes as one multi-leg
order, never leg by leg, because a partial fill on two separate orders can close the hedge and
leave the short option naked.
Autonomy runs through a scheduled endpoint that owns its own guards — interval rate gate,
market-hours check, single-run lock, timeout, kill switch — so it is safe to call twice at
once or more often than intended.

VolGuard integrates the official Alpaca MCP server over stdio for read-only account and
market inspection, with 74 tools discovered and real calls recorded in the audit ledger;
order placement stays on the deterministic REST adapter. The paper environment is enforced
at the adapter, which refuses to contact a non-paper host at all, even for a read. The
account ID is verified before execution and a kill switch blocks every path. Every configured
limit is range-checked when it is read: a value that is malformed, out of range, or
inconsistent with another refuses the whole run and names the variable, because a limit that
does not mean what was written is worse than no limit — the gates report it as passed.

Nothing in the dashboard is simulated. P&L comes only from Alpaca portfolio history and fill
activities; where data is unavailable, VolGuard says so instead of showing a zero. There is
no P&L backtest, and none is claimed — there is no historical implied-volatility series, so
the trade leg is unvalidated. The volatility forecast is a separate matter and is validated
walk-forward, strictly out of sample; see `docs/evidence/forecast-validation.md`.

The hardest thing an agent can do is decline to act. VolGuard's most common output is
NO_TRADE, each one with a specific, auditable reason. Forced activity is a bug.
```

---

## Track

```
Volatility trading (options) — options alpha / volatility track
```

## Technology tags

```
AI Agents · Algorithmic Trading · Options Trading · FinTech · Alpaca Trading API ·
Alpaca MCP Server · Anthropic Claude · Next.js · TypeScript · Vercel
```

---

## Cover image prompt

For an image model (16:9, 1920×1080):

```
A dark editorial data-visualization poster for a quantitative trading product. Near-black
charcoal background (#0b0d0d). Two overlaid volatility curves in fine linework: one in soft
acid-lime (#d9f05d) labelled IMPLIED, one in pale mint (#77e6bd) labelled REALIZED, with the
narrow gap between them filled with a subtle gradient hatch. Small precise monospace
annotations along the axes. A single bold sans-serif line of text in the lower left reading
"VOLGUARD". Generous negative space, Swiss grid discipline, no clutter, no photorealism, no
human figures, no stock-photo traders, no glowing candlestick clichés, no 3D bull or bear.
Flat vector aesthetic, high contrast, print-quality.
```

**Do not** put fabricated numbers, fake P&L figures, or invented chart values in the cover
image. Abstract curves only.

---

## Build-in-public post drafts

Five drafts. **Fill the placeholders and verify every number against a real run before
posting.** Do not post a performance claim; there is no track record.

### Post 1 — the thesis

```
Most trading agents predict direction.

Direction is a coin flip. An options position that's really a levered stock bet is a stock
signal in an options costume.

So I built VolGuard to trade what options actually price: the gap between what the market
charges for movement and what the stock actually delivers.

Building it in public for the @AlpacaHQ x @lablabai hackathon. 🧵
```

### Post 2 — the bug that changed the strategy

```
VolGuard flagged MSFT as the cheapest optionality on my whole watchlist.
57.7% realized volatility vs 24.7% implied. A screaming mispricing.

It was one +15.5% earnings gap, three weeks in the past, carrying the entire signal.

Fix: price against bipower variation (Barndorff-Nielsen & Shephard) instead of raw realized
vol. A lone gap inflates two cross-terms instead of dominating the sum.

MSFT: 57.7% raw → 41.4% jump-robust. 49% of its variance was one jump.
Now correctly rejected instead of ranked first.

The estimator you choose IS the strategy.
```

### Post 3 — the silent API trap

```
Two Alpaca behaviours that fail silently and will quietly break any volatility calculation:

1. GET /v2/stocks/{sym}/bars ignores `limit` for lookback. No `start` → you get ONE bar.
   limit=260 returned 1. Every realized-vol calc silently returned null.

2. `limit` truncates FORWARD from `start`. start=2025-07-18&limit=260 returned 260 bars
   ending 2026-07-30 — three weeks stale, and perfectly well-formed.

Open the window by date, don't bind the limit, trim client-side.

Wrote both up so the next person doesn't lose an afternoon. 🐛
```

### Post 4 — abstention as a feature

```
VolGuard scanned 14 symbols today and said no to most of them.

[Paste the real scan from the run you post about — every symbol, with the verdict the
agent actually gave. Do not reuse the numbers below; they are the shape, not the data.]

SPY   → event risk NN/100, catalyst priced in
QQQ   → IV rich +N.N vol pts, we only buy premium
MSFT  → jump-contaminated, NN% of variance was one gap
XXXX  → −N.N vol pts. Traded.

30 deterministic risk checks, 27 of them blocking. The model can propose and can veto.
Only the rules engine can approve.

"No trade" is a decision. Forced activity is a bug.
```

### Post 5 — the ship

```
VolGuard is live. 🚀

An autonomous options agent for the @AlpacaHQ x @lablabai volatility track.

→ Real IV, greeks, term structure & skew from Alpaca option chains
→ Horizon-matched realized-vol forecast (HAR-RV on jump-robust components)
→ Event-risk taxonomy over Alpaca news
→ Defined-risk vertical spreads — max loss is arithmetic, not a stop
→ 30 deterministic risk checks, 27 of them blocking
→ Official Alpaca MCP server, 74 tools, read-only
→ Append-only audit ledger on every decision

Paper only. No P&L backtest — historical option data carries no implied volatility and
expired contracts return nothing, so there is no entry signal and no outcome to score. The
probe is in the repo. The volatility forecast is validated walk-forward.

Demo: «DEMO_URL»
Code: «REPO_URL»
```

---

## Placeholders to fill before submitting

| Field | Value |
|---|---|
| Public GitHub repository URL | `«REPO_URL»` |
| Demo application URL | `«DEMO_URL»` |
| Video presentation URL | `«VIDEO_URL»` |
| Slide presentation URL | `«SLIDES_URL»` |
| Alpaca paper account ID | `«PAPER_ACCOUNT_ID»` — check whether the event requires a NEW account (`RESEARCH.md` §1 is unverified) |
| Social post URLs (up to 5) | `«POST_1»` … `«POST_5»` |
