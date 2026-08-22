import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = { ...process.env };

/**
 * The store is chosen at module load, so each case re-imports it with the environment it
 * wants. `vi.resetModules()` is what makes that possible.
 */
async function loadStore(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("../audit-store");
}

function run(id: string, withObservation = true) {
  return {
    id, startedAt: "2026-08-22T13:00:00.000Z", finishedAt: "2026-08-22T13:00:03.000Z",
    mode: "dry-run" as const, trigger: "manual" as const, status: "NO_TRADE" as const,
    symbol: "SPY",
    scanned: [{
      symbol: "SPY", verdict: "IV cheap (-1.0v) → call debit spread", varianceRiskPremium: -0.01,
      observation: withObservation ? ({ symbol: "SPY", price: 500 } as never) : null,
    }],
    observation: null, thesis: null, risk: null, orderIntent: null, alpacaOrderId: null,
    positionReviews: [], exitOrderIds: [], durationMs: 3000, message: "",
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL };
  delete process.env.VERCEL;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
  vi.doUnmock("node:fs/promises");
});

describe("where the ledger is kept", () => {
  it("uses the working directory locally", async () => {
    const store = await loadStore({ VERCEL: undefined, VOLGUARD_STORE_PATH: undefined });
    expect(store.storageStatus().path).toContain(".volguard");
    expect(store.storageStatus().ephemeral).toBe(false);
  });

  it("uses /tmp on a serverless instance, because the working directory is read-only there", async () => {
    const store = await loadStore({ VERCEL: "1", VOLGUARD_STORE_PATH: undefined });
    expect(store.storageStatus().path).toBe("/tmp/volguard/audit.json");
    // Per-instance and transient — the UI must not imply a durable ledger.
    expect(store.storageStatus().ephemeral).toBe(true);
  });

  it("honours an explicit override", async () => {
    const store = await loadStore({ VOLGUARD_STORE_PATH: "/custom/ledger.json" });
    expect(store.storageStatus().path).toBe("/custom/ledger.json");
  });
});

describe("a read-only filesystem must not take down a trading run", () => {
  /** Every write rejects, exactly as EROFS does on a serverless working directory. */
  async function readOnlyStore() {
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn().mockRejectedValue(Object.assign(new Error("EROFS: read-only file system, mkdir '/var/task/.volguard'"), { code: "EROFS" })),
      writeFile: vi.fn().mockRejectedValue(new Error("EROFS")),
      rename: vi.fn().mockRejectedValue(new Error("EROFS")),
      readFile: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    }));
    return import("../audit-store");
  }

  it("acquires the run lock instead of throwing — this is what returned a 500 on Vercel", async () => {
    const store = await readOnlyStore();
    await expect(store.acquireRunLock("run-1", 60_000)).resolves.toBe(true);
  });

  it("never rejects from any mutating call", async () => {
    const store = await readOnlyStore();
    await expect(store.saveRun(run("a") as never)).resolves.toBeUndefined();
    await expect(store.appendEvent({ id: "e1", runId: "a", createdAt: "", type: "OBSERVATION", message: "x" } as never)).resolves.toBeUndefined();
    await expect(store.recordIvObservation("SPY", 0.2, "2026-08-22")).resolves.toEqual([0.2]);
    await expect(store.markScheduledRun("2026-08-22T13:00:00Z")).resolves.toBeUndefined();
    await expect(store.releaseRunLock("run-1")).resolves.toBeUndefined();
  });

  it("still serves what it holds in memory, so the dashboard is not blank", async () => {
    const store = await readOnlyStore();
    await store.saveRun(run("a") as never);
    const runs = await store.getRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe("a");
  });

  it("reports the degradation rather than hiding it", async () => {
    const store = await readOnlyStore();
    await store.saveRun(run("a") as never);
    const status = store.storageStatus();
    expect(status.durable).toBe(false);
    expect(status.ephemeral).toBe(true);
    expect(status.lastError).toMatch(/EROFS/);
  });
});

describe("ledger size", () => {
  it("keeps observations on the newest run and drops them from older ones", async () => {
    const store = await loadStore({ VOLGUARD_STORE_PATH: "/tmp/volguard-test/ledger.json" });
    store.resetStoreCache();
    await store.saveRun(run("first") as never);
    await store.saveRun(run("second") as never);

    const runs = await store.getRuns();
    expect(runs[0].id).toBe("second");
    // Only the run on screen needs its analysis; keeping it on all 100 made the ledger MBs.
    expect(runs[0].scanned[0].observation).not.toBeNull();
    expect(runs[1].scanned[0].observation).toBeNull();
  });
});
