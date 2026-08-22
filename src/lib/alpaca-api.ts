import type {
  AlpacaAccount,
  AlpacaBar,
  AlpacaClock,
  AlpacaNewsItem,
  AlpacaOptionContract,
  AlpacaOptionSnapshot,
  AlpacaQuote,
} from "./types";
import { getConfig } from "./config";

export class AlpacaApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly payload?: unknown) {
    super(message);
    this.name = "AlpacaApiError";
  }
}

/** 429 and 5xx are worth another attempt; 4xx means the request itself is wrong. */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Days to the latest expiry present in a snapshot map; -1 when none parse. */
function farthestDteSeen(snapshots: Record<string, unknown>): number {
  let furthest = -1;
  for (const symbol of Object.keys(snapshots)) {
    const match = /^[A-Z]+(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(symbol);
    if (!match) continue;
    const expiry = Date.parse(`20${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    if (Number.isNaN(expiry)) continue;
    furthest = Math.max(furthest, Math.round((expiry - Date.now()) / 86_400_000));
  }
  return furthest;
}

export class AlpacaClient {
  private readonly config = getConfig();

  constructor(private readonly attempts = 3) {}

  private async request<T>(base: string, endpoint: string, init?: RequestInit): Promise<T> {
    if (!this.config.apiKey || !this.config.secretKey) {
      throw new AlpacaApiError("Alpaca credentials are not configured", 401);
    }
    if (!this.config.paperOnly) {
      throw new AlpacaApiError("Refusing to call a non-paper Alpaca endpoint", 403);
    }

    let lastError: AlpacaApiError | null = null;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${base}${endpoint}`, {
          ...init,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "APCA-API-KEY-ID": this.config.apiKey,
            "APCA-API-SECRET-KEY": this.config.secretKey,
            ...(init?.headers ?? {}),
          },
          cache: "no-store",
        });
      } catch (error) {
        lastError = new AlpacaApiError(error instanceof Error ? error.message : "Network failure", 0);
        if (attempt < this.attempts) {
          await sleep(200 * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }

      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = { message: text.slice(0, 200) };
      }

      if (response.ok) return payload as T;

      const message =
        typeof (payload as { message?: unknown })?.message === "string"
          ? (payload as { message: string }).message
          : `Alpaca request failed (${response.status})`;
      lastError = new AlpacaApiError(message, response.status, payload);
      if (attempt < this.attempts && isRetryable(response.status)) {
        await sleep(200 * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }
    throw lastError ?? new AlpacaApiError("Alpaca request failed", 0);
  }

  // ---- Account and session -------------------------------------------------

  getAccount(): Promise<AlpacaAccount> {
    return this.request<AlpacaAccount>(this.config.baseUrl, "/v2/account");
  }

  getClock(): Promise<AlpacaClock> {
    return this.request<AlpacaClock>(this.config.baseUrl, "/v2/clock");
  }

  getPositions(): Promise<Array<Record<string, unknown>>> {
    return this.request<Array<Record<string, unknown>>>(this.config.baseUrl, "/v2/positions");
  }

  getPortfolioHistory(period = "1M", timeframe = "1D"): Promise<{
    timestamp?: number[];
    equity?: number[];
    profit_loss?: number[];
    profit_loss_pct?: number[];
    base_value?: number;
  }> {
    return this.request(this.config.baseUrl, `/v2/account/portfolio/history?period=${period}&timeframe=${timeframe}`);
  }

  getActivities(type = "FILL", pageSize = 100): Promise<Array<Record<string, unknown>>> {
    return this.request(this.config.baseUrl, `/v2/account/activities/${encodeURIComponent(type)}?page_size=${pageSize}`);
  }

  // ---- Orders --------------------------------------------------------------

  getOrders(status = "all", limit = 50): Promise<Array<Record<string, unknown>>> {
    return this.request(this.config.baseUrl, `/v2/orders?status=${status}&limit=${limit}&nested=true`);
  }

  getOrderById(id: string): Promise<Record<string, unknown>> {
    return this.request(this.config.baseUrl, `/v2/orders/${encodeURIComponent(id)}?nested=true`);
  }

  /** Used for idempotency: a duplicate client order id must not become a second order. */
  async findOrderByClientId(clientOrderId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.request(
        this.config.baseUrl,
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
      );
    } catch (error) {
      if (error instanceof AlpacaApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** async so the paper-only guard rejects rather than throwing past a caller's `.catch()`. */
  async submitOrder(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.config.paperOnly) {
      throw new AlpacaApiError("Refusing to submit an order outside the paper environment", 403);
    }
    return this.request(this.config.baseUrl, "/v2/orders", { method: "POST", body: JSON.stringify(payload) });
  }

  cancelOrder(id: string): Promise<void> {
    return this.request(this.config.baseUrl, `/v2/orders/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // ---- Equity market data --------------------------------------------------

  getStockSnapshot(symbol: string): Promise<Record<string, unknown>> {
    return this.request(
      this.config.dataUrl,
      `/v2/stocks/${encodeURIComponent(symbol)}/snapshot?feed=${this.config.stockFeed}`,
    );
  }

  /**
   * Daily bars ending at the latest session, oldest first.
   *
   * Two Alpaca behaviours make the naive request wrong, and both fail silently:
   *   1. Without an explicit `start`, only the current session is returned.
   *   2. `limit` truncates forward from `start`, so a small limit with an early start
   *      yields a window that ends weeks in the past while still looking well-formed.
   * So the window is opened by date, requested without a binding limit, and trimmed here.
   */
  async getStockBars(symbol: string, sessions = 260): Promise<AlpacaBar[]> {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - Math.ceil(sessions * 1.5) - 7);
    const query = new URLSearchParams({
      timeframe: "1Day",
      limit: "10000",
      adjustment: "split",
      feed: this.config.stockFeed,
      start: start.toISOString().slice(0, 10),
    });
    const payload = await this.request<{ bars?: AlpacaBar[] }>(
      this.config.dataUrl,
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?${query.toString()}`,
    );
    return (payload.bars ?? []).slice(-sessions);
  }

  async getNews(symbols: string[], limit = 20): Promise<AlpacaNewsItem[]> {
    const payload = await this.request<{ news?: AlpacaNewsItem[] }>(
      this.config.dataUrl,
      `/v1beta1/news?symbols=${encodeURIComponent(symbols.join(","))}&limit=${limit}&sort=desc`,
    );
    return payload.news ?? [];
  }

  async getCorporateActions(symbol: string, start: string, end: string): Promise<string[]> {
    try {
      const payload = await this.request<{ corporate_actions?: Record<string, Array<Record<string, unknown>>> }>(
        this.config.dataUrl,
        `/v1/corporate-actions?symbols=${encodeURIComponent(symbol)}&start=${start}&end=${end}&limit=20`,
      );
      return Object.entries(payload.corporate_actions ?? {}).flatMap(([kind, rows]) =>
        rows.map((row) => `${kind.replace(/_/g, " ")} ex-date ${String(row.ex_date ?? row.process_date ?? "?")}`),
      );
    } catch {
      return [];
    }
  }

  // ---- Options -------------------------------------------------------------

  async getOptionContracts(params: {
    symbol: string;
    expirationGte: string;
    expirationLte: string;
    strikeGte?: number;
    strikeLte?: number;
    type?: "call" | "put";
    limit?: number;
  }): Promise<AlpacaOptionContract[]> {
    const query = new URLSearchParams({
      underlying_symbols: params.symbol,
      status: "active",
      expiration_date_gte: params.expirationGte,
      expiration_date_lte: params.expirationLte,
      limit: String(params.limit ?? 500),
    });
    if (params.strikeGte !== undefined) query.set("strike_price_gte", params.strikeGte.toFixed(2));
    if (params.strikeLte !== undefined) query.set("strike_price_lte", params.strikeLte.toFixed(2));
    if (params.type) query.set("type", params.type);
    const payload = await this.request<{ option_contracts?: AlpacaOptionContract[] }>(
      this.config.baseUrl,
      `/v2/options/contracts?${query.toString()}`,
    );
    return payload.option_contracts ?? [];
  }

  /**
   * Chain snapshot. This is the only Alpaca endpoint that returns quote, greeks and
   * implied volatility together, which is what makes the volatility analysis possible.
   */
  async getOptionChain(params: {
    symbol: string;
    type?: "call" | "put";
    strikeGte?: number;
    strikeLte?: number;
    expirationGte?: string;
    expirationLte?: string;
    limit?: number;
    /** Stop paging once an expiry at least this many days out has been seen. */
    targetDte?: number;
    /** Hard cap on requests, so a huge chain cannot stall a run. */
    maxPages?: number;
  }): Promise<Record<string, AlpacaOptionSnapshot>> {
    const pageSize = params.limit ?? 500;
    const maxPages = params.maxPages ?? 6;
    const snapshots: Record<string, AlpacaOptionSnapshot> = {};
    let pageToken: string | undefined;

    // Alpaca returns snapshots ordered by contract symbol, which sorts by expiry, so a
    // single page of a liquid chain contains only the nearest expiries: SPY at limit=500
    // returns two, both ~8 days out. Without following next_page_token the "expiry nearest
    // the target horizon" choice silently degrades to "nearest expiry available", and the
    // agent trades the highest-gamma part of the curve while believing it targets ~30 days.
    for (let page = 0; page < maxPages; page += 1) {
      const query = new URLSearchParams({ feed: this.config.optionFeed, limit: String(pageSize) });
      if (params.type) query.set("type", params.type);
      if (params.strikeGte !== undefined) query.set("strike_price_gte", params.strikeGte.toFixed(2));
      if (params.strikeLte !== undefined) query.set("strike_price_lte", params.strikeLte.toFixed(2));
      if (params.expirationGte) query.set("expiration_date_gte", params.expirationGte);
      if (params.expirationLte) query.set("expiration_date_lte", params.expirationLte);
      if (pageToken) query.set("page_token", pageToken);

      const payload = await this.request<{
        snapshots?: Record<string, AlpacaOptionSnapshot>;
        next_page_token?: string | null;
      }>(this.config.dataUrl, `/v1beta1/options/snapshots/${encodeURIComponent(params.symbol)}?${query.toString()}`);

      Object.assign(snapshots, payload.snapshots ?? {});
      pageToken = payload.next_page_token ?? undefined;
      if (!pageToken) break;
      if (params.targetDte !== undefined && farthestDteSeen(snapshots) >= params.targetDte) break;
    }
    return snapshots;
  }

  /** Alpaca nests latest option quotes under `quotes`, keyed by contract symbol. */
  async getOptionQuotes(symbols: string[]): Promise<Record<string, AlpacaQuote>> {
    if (symbols.length === 0) return {};
    const payload = await this.request<{ quotes?: Record<string, AlpacaQuote> }>(
      this.config.dataUrl,
      `/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(symbols.join(","))}&feed=${this.config.optionFeed}`,
    );
    return payload.quotes ?? {};
  }
}
