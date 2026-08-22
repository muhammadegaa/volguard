import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRun, AuditEvent } from "./types";

interface StoreData {
  runs: AgentRun[];
  events: AuditEvent[];
  /** Daily ATM implied-vol observations per symbol. Alpaca serves no IV history, so
   *  VolGuard accumulates its own in order to rank implied vol honestly over time. */
  ivHistory: Record<string, Array<{ date: string; atmIv: number }>>;
  /** Set when a run is in flight; prevents overlapping scheduled runs. */
  runLock: { runId: string; startedAt: string } | null;
  lastScheduledRunAt: string | null;
}

const EMPTY: StoreData = { runs: [], events: [], ivHistory: {}, runLock: null, lastScheduledRunAt: null };

/**
 * Where the ledger lives.
 *
 * A serverless function's working directory is read-only — on Vercel `process.cwd()` is
 * `/var/task`, and every write there fails with EROFS. `/tmp` is the one writable path, so
 * that is where a serverless deployment keeps its ledger. It survives for the lifetime of
 * the instance and no longer, which `storageStatus()` reports rather than implying a
 * durability the deployment does not have.
 */
const serverless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const storePath = process.env.VOLGUARD_STORE_PATH
  ?? (serverless ? "/tmp/volguard/audit.json" : path.join(process.cwd(), ".volguard", "audit.json"));

/**
 * The in-process copy is authoritative once loaded.
 *
 * It means a storage failure degrades to memory instead of taking down the run, and it means
 * a read never silently returns an empty ledger just because a write failed earlier — which
 * previously showed a judge a permanently blank dashboard with no indication why.
 */
let memory: StoreData | null = null;
let durable = true;
let lastStorageError: string | null = null;

export interface StorageStatus {
  /** True when the ledger is being persisted to disk and will survive a restart. */
  durable: boolean;
  path: string;
  /** Set when persistence failed; the run continues on the in-memory copy. */
  lastError: string | null;
  /** True when the instance is serverless, so history is per-instance and transient. */
  ephemeral: boolean;
}

export function storageStatus(): StorageStatus {
  return { durable, path: storePath, lastError: lastStorageError, ephemeral: serverless || !durable };
}

/** Serializes writes within a process so concurrent runs cannot clobber the store. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Mutate the store. Never rejects.
 *
 * A trading run must not die because a ledger write failed: losing the audit record of a
 * decision is bad, and failing to make the decision at all is worse. Previously this
 * returned the rejecting promise, so on a read-only filesystem `acquireRunLock` threw
 * before the agent's own try block and the API returned a 500 carrying the raw errno.
 */
function withStore<T>(fn: (data: StoreData) => Promise<T> | T, fallback: T): Promise<T> {
  const next = queue.then(async () => {
    const data = await readStore();
    const result = await fn(data);
    memory = data;
    await persist(data);
    return result;
  }).catch((error) => {
    lastStorageError = error instanceof Error ? error.message : "unknown storage error";
    return fallback;
  });
  queue = next.catch(() => undefined);
  return next;
}

async function readStore(): Promise<StoreData> {
  if (memory) return memory;
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<StoreData>;
    memory = { ...EMPTY, ...parsed, ivHistory: parsed.ivHistory ?? {} };
  } catch {
    memory = { ...EMPTY, ivHistory: {} };
  }
  return memory;
}

async function persist(data: StoreData): Promise<void> {
  try {
    await mkdir(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), "utf8");
    await rename(tmp, storePath);
    durable = true;
    lastStorageError = null;
  } catch (error) {
    // Keep serving from memory. The status is surfaced rather than swallowed.
    durable = false;
    lastStorageError = error instanceof Error ? error.message : "unknown storage error";
  }
}

/**
 * Per-symbol observations are only ever rendered for the run currently on screen, and they
 * inflate a run record roughly twenty-five fold. Keeping them on every retained run turned
 * the ledger into megabytes and the dashboard payload into tens of kilobytes polled every
 * thirty seconds, so older runs keep the verdict and drop the analysis behind it.
 */
function stripObservations(run: AgentRun): AgentRun {
  if (!run.scanned.some((entry) => entry.observation)) return run;
  return { ...run, scanned: run.scanned.map((entry) => ({ ...entry, observation: null })) };
}

export async function saveRun(run: AgentRun): Promise<void> {
  await withStore((data) => {
    const previous = data.runs.filter((item) => item.id !== run.id).map(stripObservations);
    data.runs = [run, ...previous].slice(0, 100);
  }, undefined);
}

export async function appendEvent(event: AuditEvent): Promise<void> {
  await withStore((data) => {
    data.events = [event, ...data.events].slice(0, 1000);
  }, undefined);
}

export async function getRuns(limit = 20): Promise<AgentRun[]> {
  return (await readStore()).runs.slice(0, limit);
}

export async function getEvents(limit = 60): Promise<AuditEvent[]> {
  return (await readStore()).events.slice(0, limit);
}

export async function getRunById(id: string): Promise<AgentRun | null> {
  return (await readStore()).runs.find((run) => run.id === id) ?? null;
}

/** Append today's ATM IV for a symbol (one sample per day) and return the full series. */
export async function recordIvObservation(symbol: string, atmIv: number, date: string): Promise<number[]> {
  return withStore((data) => {
    const series = data.ivHistory[symbol] ?? [];
    const existing = series.findIndex((item) => item.date === date);
    if (existing >= 0) series[existing] = { date, atmIv };
    else series.push({ date, atmIv });
    data.ivHistory[symbol] = series.slice(-504);
    return data.ivHistory[symbol].map((item) => item.atmIv);
  }, []);
}

export async function getIvHistory(symbol: string): Promise<number[]> {
  return ((await readStore()).ivHistory[symbol] ?? []).map((item) => item.atmIv);
}

/**
 * Acquire the single-run lock. Returns false when another run is already in flight and
 * has not exceeded `staleMs`, which is what stops overlapping scheduled invocations.
 *
 * The lock is process-local. On a serverless fleet each instance holds its own, so it does
 * not prevent two instances running concurrently — the same caveat the rate limiter carries,
 * but with order-duplication rather than throughput consequences. The deterministic client
 * order id is what actually prevents a duplicate order reaching Alpaca.
 */
export async function acquireRunLock(runId: string, staleMs: number): Promise<boolean> {
  return withStore((data) => {
    const lock = data.runLock;
    if (lock) {
      const age = Date.now() - Date.parse(lock.startedAt);
      if (Number.isFinite(age) && age < staleMs) return false;
    }
    data.runLock = { runId, startedAt: new Date().toISOString() };
    return true;
  }, true);
}

export async function releaseRunLock(runId: string): Promise<void> {
  await withStore((data) => {
    if (data.runLock?.runId === runId) data.runLock = null;
  }, undefined);
}

export async function getScheduleState(): Promise<{ lastScheduledRunAt: string | null; locked: boolean }> {
  const data = await readStore();
  return { lastScheduledRunAt: data.lastScheduledRunAt, locked: Boolean(data.runLock) };
}

export async function markScheduledRun(at: string): Promise<void> {
  await withStore((data) => {
    data.lastScheduledRunAt = at;
  }, undefined);
}

/** Test seam: the module-level cache would otherwise leak between cases. */
export function resetStoreCache(): void {
  memory = null;
  durable = true;
  lastStorageError = null;
}
