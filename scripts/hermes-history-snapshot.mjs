// This capability attests a bounded, read-only comparison of two complete
// reads. It does not attest a transaction across pages or a finished run.
export const HISTORY_SNAPSHOT_CAPABILITY = 'hermes-history-snapshot-v1';
export const snapshotError = (code = 'history_snapshot_unverified') => Object.assign(new Error('History snapshot unavailable'), { code });
const deadlines = new WeakMap();

export function assertSnapshotActive(signal) {
  const budget = signal && deadlines.get(signal);
  if (budget && performance.now() >= budget.until) {
    budget.controller.abort();
    throw snapshotError('history_snapshot_timeout');
  }
  signal?.throwIfAborted();
}

export async function withSnapshotDeadline(operation, timeoutMs = 10_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw snapshotError();
  const controller = new AbortController();
  deadlines.set(controller.signal, { controller, until: performance.now() + timeoutMs });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(snapshotError('history_snapshot_timeout')); }, timeoutMs);
  });
  try { const result = await Promise.race([operation(controller.signal), timeout]); assertSnapshotActive(controller.signal); return result; }
  finally { clearTimeout(timer); controller.abort(); deadlines.delete(controller.signal); }
}

export async function captureHistorySnapshot({ source, readComplete, verifyUnchanged, signal }) {
  assertSnapshotActive(signal);
  const first = await readComplete(signal);
  assertSnapshotActive(signal);
  const second = await readComplete(signal);
  assertSnapshotActive(signal);
  // Compare every checked source record, including records omitted from the
  // display. Equal text is never used as message identity or deduplicated.
  if (!Array.isArray(first?.records) || !Array.isArray(second?.records)
    || JSON.stringify(first.records) !== JSON.stringify(second.records)
    || JSON.stringify(first.messages) !== JSON.stringify(second.messages)) throw snapshotError('history_snapshot_changed');
  await verifyUnchanged();
  assertSnapshotActive(signal);
  return { schemaVersion: 1, complete: true, completeness: 'display-history', consistency: 'two-complete-reads-match', source, messages: second.messages };
}

export function snapshotDisplayMessages(rows, { idKey = 'id', contentKey = 'content' } = {}) {
  const ids = new Set();
  const messages = [];
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row[idKey]) || row[idKey] <= 0 || ids.has(row[idKey])
      || !['user', 'assistant', 'system', 'tool', 'command', 'moa'].includes(row.role)
      || typeof row[contentKey] !== 'string') throw snapshotError();
    ids.add(row[idKey]);
    if (['user', 'assistant', 'system'].includes(row.role)) messages.push({ id: String(row[idKey]), role: row.role, content: row[contentKey] });
  }
  return messages;
}
