import { FileConflictError, getFs, joinPath } from '../fs';
import type { AiTask } from '../settings';

export interface UsageRecord {
  id: string;
  createdAt: string;
  task: AiTask;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  status: 'complete' | 'aborted' | 'error';
  /** Only a fixed accounting explanation; never include prompts, responses, keys or raw errors. */
  note?: string;
}

const LEDGER_PATH = '.askdown/usage.json';
const listeners = new Map<string, Set<() => void>>();
const vaultKey = (vault: string) => joinPath(vault, LEDGER_PATH);
const tokenCount = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

function parseRecord(value: unknown): UsageRecord {
  if (!value || typeof value !== 'object') throw new Error('用量记录格式错误。');
  const record = value as UsageRecord;
  if (typeof record.id !== 'string' || !record.id || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
    || !['ask', 'tidy', 'summary', 'test'].includes(record.task)
    || typeof record.provider !== 'string' || !record.provider || typeof record.model !== 'string' || !record.model
    || !tokenCount(record.inputTokens) || !tokenCount(record.outputTokens) || !tokenCount(record.cacheReadTokens) || !tokenCount(record.cacheWriteTokens)
    || !(record.costUsd === null || (typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) && record.costUsd >= 0))
    || !['complete', 'aborted', 'error'].includes(record.status)
    || (record.note !== undefined && typeof record.note !== 'string')) {
    throw new Error('用量记录格式错误。');
  }
  // Explicitly select accounting fields so extra runtime properties cannot persist document content or credentials.
  return {
    id: record.id, createdAt: record.createdAt, task: record.task, provider: record.provider, model: record.model,
    inputTokens: record.inputTokens, outputTokens: record.outputTokens, cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens, costUsd: record.costUsd, status: record.status,
    ...(record.note === undefined ? {} : { note: record.note }),
  };
}

function parseLedger(raw: string | null): UsageRecord[] {
  if (raw === null) return [];
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !Array.isArray(value.records)) throw new Error();
    const records = value.records.map(parseRecord) as UsageRecord[];
    const ids = new Set<string>();
    for (const record of records) {
      if (ids.has(record.id)) throw new Error();
      ids.add(record.id);
    }
    return records;
  } catch {
    throw new Error('用量账本损坏或版本不受支持，请检查 .askdown/usage.json；现有记录不会被覆盖。');
  }
}

/** Read every persisted call for this vault. Missing ledgers are empty; all other read failures reject. */
export async function loadUsage(vault: string): Promise<UsageRecord[]> {
  const fs = await getFs();
  const path = vaultKey(vault);
  return parseLedger(await fs.exists(path) ? await fs.read(path) : null);
}

/** Subscribe to successful in-process writes. External changes are loaded by an explicit refresh. */
export function subscribeUsage(vault: string, listener: () => void): () => void {
  const key = vaultKey(vault);
  let group = listeners.get(key);
  if (!group) { group = new Set(); listeners.set(key, group); }
  group.add(listener);
  return () => {
    group.delete(listener);
    if (group.size === 0) listeners.delete(key);
  };
}

/**
 * Append a completed call without pruning history. Null vault intentionally does not persist anything.
 * The same ID and identical record are idempotent; conflicting reuse of an ID rejects.
 * CAS conflicts merge the latest ledger and retry, preserving writes from other calls/windows.
 * Any non-conflict read/write failure rejects; subscribers are only notified after persistence.
 */
export async function recordUsage(vault: string | null, record: UsageRecord): Promise<void> {
  if (vault === null) return;
  const saved = parseRecord(record);
  const serialized = JSON.stringify(saved);
  const fs = await getFs();
  const path = vaultKey(vault);
  let expected = await fs.exists(path) ? await fs.read(path) : null;
  while (true) {
    const records = parseLedger(expected);
    const previous = records.find((item) => item.id === saved.id);
    if (previous) {
      if (JSON.stringify(previous) !== serialized) throw new Error('调用 ID 已有不同的用量记录，未覆盖原记录。');
      return;
    }
    records.push(saved);
    try {
      await fs.write(path, JSON.stringify({ version: 1, records }), { root: vault, expected });
      break;
    } catch (error) {
      if (!(error instanceof FileConflictError)) throw error;
      expected = error.current;
    }
  }
  for (const listener of listeners.get(path) ?? []) {
    try { listener(); } catch { /* A subscriber cannot turn a persisted write into a reported save failure. */ }
  }
}
