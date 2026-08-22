# VolGuard Research Notes

Last verified: **2026-08-19**, against the live Alpaca paper API using the configured
development credentials. Every Alpaca claim below was reproduced with a real request; where
a request failed, the failure is recorded rather than omitted.

---

## 1. Hackathon requirements

Primary source: <https://lablab.ai/ai-hackathons/alpaca-ai-trading-agents-hackathon>

**Caveat on sourcing.** The lablab event page is client-rendered; a plain HTTP fetch returns
only the page shell, so the detail below is corroborated from the lablab live dashboard
(<https://lablab.ai/ai-hackathons/alpaca-ai-trading-agents-hackathon/live>) and a third-party
mirror (<https://hiretoday.in/competitiondetails/40000151>). **Re-verify the exact wording on
the official page at registration** before relying on it for the submission.

| Item | Verified value |
|---|---|
| Event | Alpaca AI Trading Agents Hackathon, hosted by lablab.ai with Alpaca |
| Format | Fully online, seven days |
| Registration opens | 28 Aug 2026, 15:00 UTC |
| Event runs | 28 Aug 2026 → 4 Sept 2026 |
| Submission deadline | 4 Sept 2026, 15:00 UTC |
| Prize pool | $5,000 — 1st $2,500 · 2nd $1,500 · 3rd $1,000 |
| Registration fee | Free |
| Contact | community@lablab.ai |

**Eligibility (hard requirements):**

- Open to participants aged 18+ worldwide.
- Projects **must use Alpaca's Trading API** *and* **either its MCP server or its CLI**.
  This is an eligibility rule, not a bonus — MCP/CLI is not optional.
- Strategies **must incorporate options trading**.
- Projects run in the **paper trading environment**.
- Final submission requires a **new, dedicated Alpaca paper trading account**. Projects
  submitted on an existing or reused account are **not eligible for judging**.
- Submissions must be original and MIT-compliant.
- Up to **five** social media post links may be submitted.

**Judging criteria (as listed on the mirror):**

1. P&L Performance
2. Technology Implementation
3. Creativity & Originality
4. Presentation & Execution

> Note: earlier project notes listed a fifth "Social Engagement" criterion. That is **not**
> confirmed by the sources available. Social posts are a *submission field* (up to five
> links); whether they are separately scored is unverified. Treat social as a submission
> asset, not a confirmed scoring axis, until the official page is checked.

**Tracks / categories:** Artificial Intelligence · Algorithmic Trading · AI Agents ·
FinTech · Options Trading. The event description states tracks "cover options alpha,
volatility trading, hedging and portfolio overlays."

**VolGuard targets volatility trading.**

---

## 2. Alpaca options — verified capabilities

Sources: <https://docs.alpaca.markets/docs/options-trading>,
<https://docs.alpaca.markets/docs/options-level-3-trading>,
<https://docs.alpaca.markets/reference/optionchain>, plus live probes.

### Confirmed by live request

| Capability | Result |
|---|---|
| Paper account options level | `options_approved_level: 3`, `options_trading_level: 3` — multi-leg spreads permitted |
| Account equity / status | $100,000, `ACTIVE` |
| Multi-leg order validation | `POST /v2/orders` with `order_class: "mleg"` and 0 legs returns `422 42210000: "mleg orders must have at least 2 legs and at most 4 legs"` |
| Option contracts | `GET /v2/options/contracts` with `expiration_date_gte/lte`, `strike_price_gte/lte`, `type` all work |
| **Option chain snapshot** | `GET /v1beta1/options/snapshots/{underlying}` returns `dailyBar`, **`greeks` (delta, gamma, theta, vega, rho)**, **`impliedVolatility`**, `latestQuote`, `latestTrade`, `minuteBar`, `prevDailyBar` |
| Chain filters | `type`, `strike_price_gte/lte`, `expiration_date_gte/lte`, `limit` (max 1000), `page_token` |
| Latest option quotes | `GET /v1beta1/options/quotes/latest` returns `{"quotes": {SYMBOL: {...}}}` — **nested under `quotes`** |
| Corporate actions | `GET /v1/corporate-actions` returns `cash_dividends` with `ex_date` |
| News | `GET /v1beta1/news` returns `headline`, `source`, `created_at`, `symbols`, `summary`, `url` |
| Portfolio history | `GET /v2/account/portfolio/history` returns `timestamp`, `equity`, `profit_loss`, `profit_loss_pct`, `base_value` arrays |
| Calendar | `GET /v2/calendar` returns session open/close and settlement dates |

**Order rules confirmed in docs:** `qty` must be a whole number; `notional` must not be set;
`time_in_force` must be `day` or `gtc`; `extended_hours` must be false; `stop`/`stop_limit`
are single-leg only; multi-leg orders accept 2–4 legs; leg ratios must be in simplest form
(GCD 1); equity legs in a multi-leg order are **not supported**.

### Confirmed limitations (this account / data plan)

| Limitation | Evidence | VolGuard's response |
|---|---|---|
| **OPRA feed unavailable** | `feed=opra` → `403 "OPRA agreement is not signed"` | Uses the free `indicative` feed. Quotes are modified and trades delayed; this is disclosed in the UI and README. |
| **Index data (VIX/SPX) unavailable** | `GET /v1beta1/indices/values` → `403 "forbidden: insufficient grants"`; MCP `get_index_latest_values` → same 403 | No VIX. VolGuard computes its **own** ATM IV term structure from the chain instead, which is more direct than a VIX proxy anyway. |
| **`open_interest` often null** | Returned `null` for many contracts, populated for others | Open interest is an **advisory**, non-blocking risk check. Liquidity gating uses quote size and relative spread, which are always present. |
| **SIP stock snapshot unavailable** | `/v2/stocks/{s}/snapshot?feed=sip` → `403` | Uses `iex`. SIP *historical bars* do work, and were checked against IEX: realized vol agrees to within 0.2 vol points (SPY 15.0% vs 15.1%), so IEX is adequate for this purpose. |
| **No IV history endpoint** | No Alpaca endpoint serves historical implied volatility | VolGuard persists its own daily ATM IV observation per symbol and reports `impliedVolRank: null` with a visible sample count until 20 observations exist. It never fabricates a rank. |
| **No order dry-run endpoint** | Alpaca has no order validation endpoint | Payload correctness is enforced by the deterministic risk engine and unit tests; the 422 probe above confirms server-side leg validation. |

### Two Alpaca behaviours that fail silently (both were live bugs in this project)

1. **`GET /v2/stocks/{symbol}/bars` ignores `limit` for lookback.** With no `start`, it
   returns **only the current session** — `limit=260` yielded 1 bar. Any realized-volatility
   calculation built on it silently returns `null`.
2. **`limit` truncates *forward* from `start`.** `start=2025-07-18&limit=260` returned 260
   bars ending **2026-07-30** — three weeks stale — while still looking well-formed.
   Correct approach: open the window by date, request without a binding limit, and trim
   client-side. VolGuard does this in `getStockBars`.

Both are documented here because they are easy to reproduce and easy to miss.

---

## 3. Official Alpaca MCP server — verified working

Source: <https://github.com/alpacahq/alpaca-mcp-server>

- Package: `alpaca-mcp-server` on PyPI, run via `uvx alpaca-mcp-server`. Requires `uv`.
- Configuration is **entirely through the MCP client's `env` block** — the server reads
  `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER_TRADE` from its own process
  environment. It does **not** read a project `.env` file.
- **Verified live:** handshake succeeds, `tools/list` returns **74 tools**, and
  `tools/call` on `get_clock` and `get_account_info` returned real paper-account data.
- Toolsets: `account`, `trading`, `watchlists`, `assets`, `stock-data`, `crypto-data`,
  `options-data`, `corporate-actions`, `news`, `fixed-income-data`, `index-data`.
- Tool output is wrapped with an `_alpaca_mcp_security` envelope marking it
  `untrusted_tool_output` — the server itself instructs clients to treat results as data,
  not instructions. VolGuard honours this: MCP output is only ever displayed, never used to
  drive an order.

**Failure mode found and fixed:** spawning the server without forwarding credentials to the
child process exits immediately with
`Error: ALPACA_API_KEY and ALPACA_SECRET_KEY must be set.` The original VolGuard bridge did
exactly this, so its "MCP integration" had never once completed a handshake.

**Deployment caveat (important, and stated in the README):** the MCP bridge spawns `uvx`, so
it requires Python and `uv` on the host. It works locally and on any container host. It will
**not** work on Vercel's serverless runtime. The Alpaca REST adapter is the execution path
in every environment; MCP is a verified read-only inspection channel.

---

## 4. Strategy research — why variance risk premium

The track is volatility, so the signal must be about the *price of movement*, not direction.

- **Implied volatility** is what the option market charges for future movement.
- **Realized volatility** is what the underlying actually delivered.
- Their difference — the **variance risk premium (VRP)** — is the single most studied
  quantity in options markets. It is usually *positive* (options are, on average, expensive),
  which is why premium selling is a crowded trade. VolGuard takes the disciplined opposite
  position: it only ever *buys* premium, and only on the comparatively rare occasions when
  the premium is negative.

**Jump contamination — the failure this project hit in practice.** On 2026-08-19, MSFT
showed a 20-day realized volatility of **57.7%** against a 24.7% implied — an apparently
enormous mispricing. Inspection of the bars showed a single **+15.5%** session on 2026-07-30
(volume 4.7M vs a ~1M baseline: a genuine earnings gap). That one already-past move was
carrying the entire signal, and the naive agent ranked MSFT as its best opportunity.

The fix is **bipower variation** (Barndorff-Nielsen & Shephard), which averages the product
of *adjacent* absolute returns rather than squaring each return, so a lone gap inflates two
cross-terms instead of dominating the sum. Measured across the live universe:

| Symbol | RV20 (raw) | BV20 (jump-robust) | Jump share |
|---|---|---|---|
| SPY | 13.5% | 13.9% | 0% |
| IWM | 14.8% | 15.9% | 0% |
| QQQ | 23.7% | 23.4% | 2% |
| NVDA | 38.7% | 35.0% | 18% |
| AAPL | 35.3% | 31.4% | 21% |
| **MSFT** | **57.7%** | **41.4%** | **49%** |

VolGuard prices the VRP against **bipower**, and additionally abstains outright when the
jump share exceeds 35%. MSFT is now correctly rejected as `jump-contaminated (49%)`.

**Why debit spreads only.** Max loss equals the premium paid and is known before the order
is built — there is no assignment tail and no margin surprise. It is also the safest subset
of what Alpaca level 3 permits. The cost is that VolGuard cannot express a "sell expensive
premium" view, which is precisely why rich IV maps to *abstain* rather than to an inverted
trade.

---

## 5. Verified end-to-end behaviour (2026-08-19, market open)

A single dry run across the six-symbol universe produced six distinct, explainable verdicts:

| Symbol | VRP | Verdict |
|---|---|---|
| SPY | −3.1v | abstain — event risk 69/100 |
| QQQ | +6.6v | abstain — IV rich |
| IWM | −1.5v | eligible, but a weaker edge than AAPL |
| **AAPL** | **−6.7v** | **selected** — bull call debit spread |
| MSFT | −16.1v | abstain — jump-contaminated (49%) |
| NVDA | +4.9v | abstain — IV rich |

Selected trade: AAPL 2026-09-18, long 315 call (Δ 0.53, IV 25.3%) / short 330 call
(Δ 0.28, IV 24.5%), net debit **$6.02**, width $15, max loss **$602**, max profit **$898**,
reward:risk **1.49:1**, breakeven $321.02. Quote ages 2–3 seconds. **All 26 risk gates
passed.** No order was submitted (dry run).

> Recorded as observed. The engine carried 26 gates on this date; a 27th (`market_open`) was
> added on 2026-08-20 when the scan was decoupled from market hours, so current runs report 27.

---

## 7. Verified paper execution (2026-08-19)

One controlled paper order was submitted with explicit operator approval and verified by
reading state back from Alpaca, not from VolGuard's own records.

| Field | Value (read back from Alpaca) |
|---|---|
| Alpaca order ID | `6231e8dd-3198-4b55-973b-d98c1f483d52` |
| Client order ID | `volguard-2026-08-19-aapl-bull_call_debit_spread` |
| Class / type / TIF | `mleg` / `limit` / `day` |
| Status | **filled**, qty 1, `filled_avg_price` 5.65 |
| Limit sent | 5.70 → filled 5.65 (**$5.00 in our favour**) |
| Long leg | `AAPL260918C00320000` buy_to_open, filled 1 @ 7.50 |
| Short leg | `AAPL260918C00340000` sell_to_open, filled 1 @ 1.85 |
| Position | long 1 / short 1, cost basis 750 / −185 |
| Account after | equity 99,976.95 · cash 99,434.95 (from 100,000) |
| Max loss | $565 realized cost, capped by structure |

**Idempotency proven live.** Re-running the agent in paper mode immediately after returned
`TRADE_REJECTED — no_duplicate_order: Alpaca already has an order with client id
volguard-2026-08-19-aapl-bull_call_debit_spread`, and the account still shows exactly **one**
order. The duplicate guard is not theoretical.

**Two bugs this trade exposed** (both fixed, both now covered by tests against the real
activity shape):

1. Alpaca FILL activities carry a **leg-level `order_id`**, not the parent `mleg` order id,
   and carry **no `position_intent` field at all**. Slippage matching by parent order id
   silently returned null, and realized-P&L detection keyed on `position_intent` would have
   reported zero closed trades forever. Realized P&L is now reconstructed by walking fills
   per contract and closing a round trip when running quantity returns to zero.
2. `maxOpenPositions` was counting **legs**, so one two-leg spread consumed two of three
   slots. It now counts distinct underlying + expiry groups.

---

## 8. Open items requiring the operator

- A **fresh, dedicated Alpaca paper account** must be created for judging; the development
  account used above is explicitly not eligible.
- The `ANTHROPIC_API_KEY` in `.env.local` currently returns
  `400 invalid_request_error: "Your credit balance is too low to access the Anthropic API."`
  The thesis layer degrades to the labelled rules engine, so nothing is broken, but the
  model-authored narration cannot be demonstrated until the account is funded.
