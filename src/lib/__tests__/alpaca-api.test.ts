import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlpacaApiError, AlpacaClient } from "../alpaca-api";

const ORIGINAL = { ...process.env };

function paperEnv() {
  process.env.ALPACA_BASE_URL = "https://paper-api.alpaca.markets";
  process.env.ALPACA_DATA_URL = "https://data.alpaca.markets";
  process.env.ALPACA_PAPER_TRADE = "true";
  process.env.ALPACA_API_KEY = "test-key";
  process.env.ALPACA_SECRET_KEY = "test-secret";
  process.env.ALPACA_OPTION_FEED = "indicative";
  process.env.ALPACA_STOCK_FEED = "iex";
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A Response body can only be read once, so retries need a fresh one each call. */
function alwaysJson(body: unknown, status = 200) {
  return () => jsonResponse(body, status);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  paperEnv();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("paper-only enforcement", () => {
  it("refuses to call a live endpoint even for a read", async () => {
    process.env.ALPACA_BASE_URL = "https://api.alpaca.markets";
    await expect(new AlpacaClient().getAccount()).rejects.toThrow(/non-paper/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to submit an order when paper mode is disabled", async () => {
    process.env.ALPACA_PAPER_TRADE = "false";
    await expect(new AlpacaClient().submitOrder({})).rejects.toThrow(/paper/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to call anything without credentials", async () => {
    process.env.ALPACA_API_KEY = "";
    await expect(new AlpacaClient().getAccount()).rejects.toThrow(/credentials/i);
  });
});

describe("getOptionQuotes", () => {
  it("reads quotes from the nested `quotes` object Alpaca actually returns", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      quotes: { SPY260820C00500000: { bp: 266.54, ap: 272.97, bs: 2, as: 10, t: "2026-08-19T15:45:37Z" } },
    }));
    const quotes = await new AlpacaClient().getOptionQuotes(["SPY260820C00500000"]);
    expect(quotes["SPY260820C00500000"].bp).toBe(266.54);
  });

  it("returns an empty map without calling the API for an empty symbol list", async () => {
    expect(await new AlpacaClient().getOptionQuotes([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getOptionChain", () => {
  it("sends the strike, expiry and feed filters and returns the snapshots map", async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      snapshots: { SPY260918C00767000: { impliedVolatility: 0.1258, greeks: { delta: 0.5887 } } },
    }));
    const chain = await new AlpacaClient().getOptionChain({
      symbol: "SPY", type: "call", strikeGte: 700, strikeLte: 800,
      expirationGte: "2026-08-26", expirationLte: "2026-09-30",
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/v1beta1/options/snapshots/SPY");
    expect(url).toContain("feed=indicative");
    expect(url).toContain("strike_price_gte=700.00");
    expect(url).toContain("expiration_date_lte=2026-09-30");
    expect(chain["SPY260918C00767000"].impliedVolatility).toBe(0.1258);
  });

  it("returns an empty map when Alpaca returns no snapshots", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    expect(await new AlpacaClient().getOptionChain({ symbol: "SPY" })).toEqual({});
  });
});

describe("getOptionContracts", () => {
  it("always constrains the expiration window so the chain is relevant to spot", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ option_contracts: [] }));
    await new AlpacaClient().getOptionContracts({
      symbol: "SPY", expirationGte: "2026-08-26", expirationLte: "2026-09-30", strikeGte: 700, strikeLte: 800,
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("expiration_date_gte=2026-08-26");
    expect(url).toContain("strike_price_lte=800.00");
  });
});

describe("retry behaviour", () => {
  it("retries a 500 and succeeds on a later attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "server error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ id: "acct", status: "ACTIVE", equity: "1", cash: "1", buying_power: "1" }));
    const account = await new AlpacaClient().getAccount();
    expect(account.status).toBe("ACTIVE");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: "rate limited" }, 429))
      .mockResolvedValueOnce(jsonResponse({ is_open: true, next_open: "", next_close: "" }));
    await expect(new AlpacaClient().getClock()).resolves.toMatchObject({ is_open: true });
  });

  it("does not retry a 422, because the request itself is invalid", async () => {
    fetchMock.mockImplementation(alwaysJson({ message: "mleg orders must have at least 2 legs" }, 422));
    await expect(new AlpacaClient().submitOrder({})).rejects.toThrow(/at least 2 legs/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget and surfaces the Alpaca message", async () => {
    fetchMock.mockImplementation(alwaysJson({ message: "still broken" }, 503));
    await expect(new AlpacaClient(2).getAccount()).rejects.toBeInstanceOf(AlpacaApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ is_open: false, next_open: "", next_close: "" }));
    await expect(new AlpacaClient().getClock()).resolves.toMatchObject({ is_open: false });
  });
});

describe("findOrderByClientId", () => {
  it("returns null on 404 so a fresh client order id is not an error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: "order not found" }, 404));
    expect(await new AlpacaClient().findOrderByClientId("volguard-x")).toBeNull();
  });

  it("returns the existing order so a duplicate can be blocked", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "order-1", client_order_id: "volguard-x" }));
    expect(await new AlpacaClient().findOrderByClientId("volguard-x")).toMatchObject({ id: "order-1" });
  });
});

describe("credentials", () => {
  it("sends the Alpaca key headers and never puts them in the URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ is_open: true, next_open: "", next_close: "" }));
    await new AlpacaClient().getClock();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("test-secret");
    expect((init.headers as Record<string, string>)["APCA-API-SECRET-KEY"]).toBe("test-secret");
  });
});
