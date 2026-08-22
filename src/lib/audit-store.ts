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

const storePath = path.join(process.cwd(), ".volguard", "audit.json");

/** Serializes writes within a process so concurrent runs cannot clobber the store. */
let queue: Promise<unknown> = Promise.resolve();
function withStore<T>(fn: (data: StoreData) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const data = await readStore();
    const result = await fn(data);
    await writeStore(data);
    return result;
  });
  queue = next.catch(() => undefined);
  return next;
}

async function readStore(): Promise<StoreData> {
  try {
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Partial<StoreData>;
    return { ...EMPTY, ...parsed, ivHistory: parsed.ivHistory ?? {} };
  } catch {
    return { ...EMPTY, ivHistory: {} };
  }
}

async function writeStore(data: StoreData): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, storePath);
}

export async function saveRun(run: AgentRun): Promise<void> {
  await withStore((data) => {
    data.runs = [run, ...data.runs.filter((item) => item.id !== run.id)].slice(0, 100);
  });
}

export async function appendEvent(event: AuditEvent): Promise<void> {
  await withStore((data) => {
    data.events = [event, ...data.events].slice(0, 1000);
  });
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
  });
}

export async function getIvHistory(symbol: string): Promise<number[]> {
  return ((await readStore()).ivHistory[symbol] ?? []).map((item) => item.atmIv);
}

/**
 * Acquire the single-run lock. Returns false when another run is already in flight and
 * has not exceeded `staleMs`, which is what stops overlapping scheduled invocations.
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
  });
}

export async function releaseRunLock(runId: string): Promise<void> {
  await withStore((data) => {
    if (data.runLock?.runId === runId) data.runLock = null;
  });
}

export async function getScheduleState(): Promise<{ lastScheduledRunAt: string | null; locked: boolean }> {
  const data = await readStore();
  return { lastScheduledRunAt: data.lastScheduledRunAt, locked: Boolean(data.runLock) };
}

export async function markScheduledRun(at: string): Promise<void> {
  await withStore((data) => {
    data.lastScheduledRunAt = at;
  });
}
