import { checkedBridgeUrl, type HermesHistorySnapshot } from '../bridge.ts';
import type { ChatLink, StoragePort } from './store.ts';

export type ReplySnapshot = HermesHistorySnapshot;
export type ReplyReadCursor = { seenCount: number; lastMessageId: string | null; prefixDigest: string; updatedAt: string };
export type ReplyReadState = { schema: 1; items: Record<string, ReplyReadCursor> };
export type ReplyCursorComparison = { status: 'baseline-unset' | 'read' | 'unread' | 'history-changed'; unreadCount: number | null };
const READ_STATE_KEY = 'hermes-read-state-v1';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Only this digest leaves the pairing boundary; no credential or URL is stored. */
export async function pairedBridgeNamespace(url: string, pairingToken: string): Promise<string> {
  if (!nonempty(pairingToken)) throw new Error('尚未配对 Bridge，无法核验回复');
  return `bridge:${await digest(['hermes-paired-bridge-v1', checkedBridgeUrl(url), pairingToken])}`;
}

/** A remote read cursor is shared across document bindings; drafts are separate. */
export function replyScopeKey(namespace: string, link: ChatLink): string {
  if (!nonempty(namespace) || !nonempty(link.storedSessionId)) throw new Error('原会话身份尚未核验');
  return JSON.stringify(['hermes-read-scope-v1', namespace, link.adapter, link.connectionId, link.profile, link.installId, link.storedSessionId]);
}

function prefixDigest(snapshot: ReplySnapshot, count: number): Promise<string> {
  return digest(['hermes-read-prefix-v1', snapshot.messages.slice(0, count).map(message => [message.id, message.role, message.content])]);
}

export async function makeReadCursor(snapshot: ReplySnapshot, updatedAt: string): Promise<ReplyReadCursor> {
  return { seenCount: snapshot.messages.length, lastMessageId: snapshot.messages.at(-1)?.id ?? null,
    prefixDigest: await prefixDigest(snapshot, snapshot.messages.length), updatedAt };
}

export async function compareReadCursor(snapshot: ReplySnapshot, cursor?: ReplyReadCursor): Promise<ReplyCursorComparison> {
  if (!cursor) return { status: 'baseline-unset', unreadCount: null };
  if (snapshot.messages.length < cursor.seenCount
    || (snapshot.messages[cursor.seenCount - 1]?.id ?? null) !== cursor.lastMessageId
    || await prefixDigest(snapshot, cursor.seenCount) !== cursor.prefixDigest) {
    return { status: 'history-changed', unreadCount: null };
  }
  const unreadCount = snapshot.messages.slice(cursor.seenCount).filter(message => message.role === 'assistant' && message.content.trim()).length;
  return { status: unreadCount ? 'unread' : 'read', unreadCount };
}

function validCursor(value: unknown): value is ReplyReadCursor {
  return record(value) && Object.keys(value).length === 4
    && Number.isSafeInteger(value.seenCount) && (value.seenCount as number) >= 0
    && (value.seenCount === 0 ? value.lastMessageId === null : nonempty(value.lastMessageId))
    && typeof value.prefixDigest === 'string' && /^[a-f0-9]{64}$/.test(value.prefixDigest) && validDate(value.updatedAt);
}

function validateState(value: unknown): ReplyReadState {
  if (value === undefined || value === '') return { schema: 1, items: {} };
  if (!record(value) || value.schema !== 1 || Object.keys(value).length !== 2 || !record(value.items)
    || !Object.entries(value.items).every(([key, cursor]) => nonempty(key) && validCursor(cursor))) {
    throw new Error('已读记录损坏或版本不兼容；已保留原数据，请先核对');
  }
  return structuredClone(value) as ReplyReadState;
}

/** Serializes this window's cursor writes, without claiming cross-device CAS. */
export class ReplyReadStateStore {
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: StoragePort) {}
  async read(): Promise<ReplyReadState> { return validateState(await this.storage.loadData(READ_STATE_KEY)); }
  write(scopeKey: string, cursor: ReplyReadCursor, isCurrent: () => boolean | Promise<boolean>, sourceCurrent: () => boolean = () => true): Promise<boolean> {
    const write = this.mutations.then(async () => {
      if (!nonempty(scopeKey) || !validCursor(cursor)) throw new Error('已读记录无效，未保存');
      const data = await this.read();
      const next: ReplyReadState = { schema: 1, items: { ...data.items, [scopeKey]: structuredClone(cursor) } };
      // The source guard must run after the asynchronous load, adjacent to save.
      if (!await isCurrent() || !sourceCurrent()) return false;
      await this.storage.saveData(READ_STATE_KEY, next);
      return true;
    });
    this.mutations = write.catch(() => undefined);
    return write;
  }
}

export type ReplySyncSource = { namespace: string; isCurrent: () => boolean };
export type ReplySyncPorts = {
  storage: StoragePort;
  captureSource: () => Promise<ReplySyncSource | null>;
  listTargets: () => Promise<{ links: ChatLink[]; unresolvedCount: number }>;
  isTargetCurrent: (link: ChatLink) => boolean | Promise<boolean>;
  readSnapshot: (link: ChatLink, signal: AbortSignal) => Promise<ReplySnapshot>;
};
export type ReplySyncStatus = ReplyCursorComparison['status'] | 'unchecked' | 'unsupported' | 'error';
export type ReplySyncRow = {
  key: string; revision: number; link: ChatLink; status: ReplySyncStatus; unreadCount: number | null;
  checkedAt: string | null; lastAttemptAt: string | null; error: string | null; canMarkRead: boolean; canOpen: boolean;
};
export type ReplySyncView = {
  rows: ReplySyncRow[]; checking: boolean; autoCheck: boolean; lastCheckedAt: string | null;
  unresolvedCount: number; remainingCount: number; feedback: string;
};
type Entry = { row: ReplySyncRow; source: ReplySyncSource; scopeKey: string | null; snapshot: ReplySnapshot | null };
type Batch = { id: number; abort: AbortController; timedOut: boolean };

function eligible(link: ChatLink): boolean {
  return link.state === 'ready' && (link.adapter === 'serve' || link.adapter === 'studio')
    && nonempty(link.chatId) && nonempty(link.documentRootId) && nonempty(link.connectionId) && nonempty(link.profile)
    && nonempty(link.storedSessionId) && (link.adapter !== 'serve' || nonempty(link.installId))
    && !link.legacyBridgeUrl && !/^https?:\/\//.test(link.connectionId);
}

function rowKey(namespace: string, link: ChatLink): string {
  return JSON.stringify([namespace, link.chatId, link.documentRootId, link.workId, link.adapter,
    link.connectionId, link.profile, link.installId, link.storedSessionId, link.state, link.legacyBridgeUrl ?? null]);
}

function checkedSnapshot(value: unknown, link: ChatLink): ReplySnapshot {
  if (!record(value) || value.schemaVersion !== 1 || value.complete !== true || value.completeness !== 'display-history'
    || value.consistency !== 'two-complete-reads-match' || !record(value.source) || !Array.isArray(value.messages)) {
    throw new Error('快照不可核验');
  }
  const source = value.source;
  if (source.chatId !== link.chatId || source.documentRootId !== link.documentRootId
    || source.connectionId !== link.connectionId || source.kind !== link.adapter || source.profile !== link.profile
    || source.storedSessionId !== link.storedSessionId || source.installId !== link.installId) throw new Error('快照来源不符');
  const ids = new Set<string>();
  for (const message of value.messages) {
    if (!record(message) || !nonempty(message.id) || ids.has(message.id)
      || typeof message.role !== 'string' || !['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string') throw new Error('快照消息不可核验');
    ids.add(message.id);
  }
  return structuredClone(value) as ReplySnapshot;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(new Error('检查已停止')); };
    if (signal.aborted) { reject(new Error('检查已停止')); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort); });
  });
}

/** Shared, read-only checker; it never owns foreground Chat, drafts or pending. */
export class ReplySyncController {
  private readonly store: ReplyReadStateStore;
  private readonly concurrency: number;
  private readonly maxTargets: number;
  private readonly budgetMs: number;
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private state = { checking: false, autoCheck: false, lastCheckedAt: null as string | null,
    unresolvedCount: 0, remainingCount: 0, feedback: '' };
  private sequence = 0;
  private batchId = 0;
  private active: Batch | null = null;
  private running: Promise<void> | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private marking = new Set<string>();
  private autoTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private offset = 0;
  private namespace: string | null = null;

  constructor(private readonly ports: ReplySyncPorts, options: { concurrency?: number; maxTargets?: number; budgetMs?: number } = {}) {
    this.store = new ReplyReadStateStore(ports.storage);
    this.concurrency = Math.max(1, Math.min(2, Math.floor(options.concurrency ?? 2)));
    this.maxTargets = Math.max(1, Math.min(40, Math.floor(options.maxTargets ?? 40)));
    this.budgetMs = Math.max(1, Math.min(20000, Math.floor(options.budgetMs ?? 20000)));
  }

  view(): ReplySyncView {
    return { ...this.state, rows: [...this.entries.values()].map(entry => ({ ...structuredClone(entry.row),
      canMarkRead: Boolean(entry.snapshot && entry.source.isCurrent() && entry.scopeKey && !this.marking.has(entry.scopeKey)),
      canOpen: entry.source.isCurrent(),
    })) };
  }

  subscribe(listener: () => void): () => void {
    if (!this.disposed) this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private current(batch: Batch, source?: ReplySyncSource): boolean {
    return !this.disposed && this.active === batch && !batch.abort.signal.aborted && (!source || source.isCurrent());
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.serial.then(operation);
    this.serial = pending.catch(() => undefined);
    return pending;
  }
  private async targetCurrent(entry: Entry): Promise<boolean> {
    return !this.disposed && entry.source.isCurrent() && await this.ports.isTargetCurrent(structuredClone(entry.row.link))
      && !this.disposed && entry.source.isCurrent();
  }

  check(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) return this.running;
    const batch: Batch = { id: ++this.batchId, abort: new AbortController(), timedOut: false };
    this.active = batch; this.state.checking = true; this.state.feedback = '正在检查已关联会话…'; this.publish();
    const timer = setTimeout(() => { batch.timedOut = true; batch.abort.abort(); }, this.budgetMs);
    const operation = this.perform(batch).finally(() => {
      clearTimeout(timer);
      if (this.active !== batch) return;
      this.active = null; this.running = null; this.state.checking = false;
      if (batch.timedOut) this.state.feedback = '本次检查已达时间上限；未完成会话保留上次结果，可再次检查。';
      this.publish();
    });
    this.running = operation;
    return operation;
  }

  private async perform(batch: Batch): Promise<void> {
    try {
      const source = await abortable(this.ports.captureSource(), batch.abort.signal);
      if (!this.current(batch)) return;
      if (!source || !source.isCurrent()) { this.state.feedback = '尚未配对可核验的 Bridge；可继续从原入口查看历史。'; return; }
      const targets = await abortable(this.ports.listTargets(), batch.abort.signal);
      if (!this.current(batch, source)) return;
      if (source.namespace !== this.namespace) { this.entries.clear(); this.namespace = source.namespace; this.offset = 0; this.state.lastCheckedAt = null; }
      const next = new Map<string, Entry>();
      for (const original of targets.links) {
        const link = structuredClone(original), key = rowKey(source.namespace, link);
        if (next.has(key)) continue;
        const previous = this.entries.get(key);
        if (previous) { previous.row.link = link; previous.source = source; next.set(key, previous); continue; }
        const supported = eligible(link);
        next.set(key, { source, scopeKey: supported ? replyScopeKey(source.namespace, link) : null, snapshot: null,
          row: { key, revision: ++this.sequence, link, status: supported ? 'unchecked' : 'unsupported', unreadCount: null,
            checkedAt: null, lastAttemptAt: null, error: null, canMarkRead: false, canOpen: true } });
      }
      this.entries = next; this.state.unresolvedCount = targets.unresolvedCount;
      const eligibleEntries = [...next.values()].filter(entry => entry.scopeKey);
      const count = Math.min(eligibleEntries.length, this.maxTargets);
      const start = this.offset;
      const selected = Array.from({ length: count }, (_, index) => eligibleEntries[(start + index) % eligibleEntries.length]);
      this.state.remainingCount = eligibleEntries.length - selected.length;
      this.publish();
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(this.concurrency, selected.length) }, async () => {
        while (this.current(batch, source)) {
          if (index >= selected.length) return;
          const entry = selected[index++];
          await this.inspect(batch, entry);
        }
      }));
      if (this.active === batch && source.isCurrent()) {
        // Advance by attempts, not the planned cap: a slow first group must not
        // starve every later session whenever the shared deadline is reached.
        this.offset = eligibleEntries.length ? (start + index) % eligibleEntries.length : 0;
        this.state.remainingCount = eligibleEntries.length - index;
      }
      if (this.current(batch, source)) {
        this.state.lastCheckedAt = new Date().toISOString();
        this.state.feedback = selected.some(entry => entry.row.error)
          ? '本次部分会话未能核验；已保留上次结果和检查时间。'
          : this.state.remainingCount ? '本次有界检查已完成；其余会话可继续检查。' : '本次检查完成；不会自动标记已读。';
      }
    } catch {
      if (this.current(batch)) this.state.feedback = '检查失败；已保留上次结果，请核对连接后重试。';
    }
  }

  private async inspect(batch: Batch, entry: Entry): Promise<void> {
    entry.row.lastAttemptAt = new Date().toISOString();
    try {
      if (!await abortable(this.targetCurrent(entry), batch.abort.signal) || !this.current(batch, entry.source)) return;
      const value = await abortable(this.ports.readSnapshot(structuredClone(entry.row.link), batch.abort.signal), batch.abort.signal);
      const snapshot = checkedSnapshot(value, entry.row.link);
      await abortable(this.queue(async () => {
        if (!this.current(batch, entry.source) || !await this.targetCurrent(entry)) return;
        const state = await this.store.read();
        const comparison = await compareReadCursor(snapshot, state.items[entry.scopeKey!]);
        if (!this.current(batch, entry.source) || !await this.targetCurrent(entry)
          || !this.current(batch, entry.source) || this.entries.get(entry.row.key) !== entry) return;
        entry.snapshot = snapshot; entry.row = { ...entry.row, ...comparison, revision: ++this.sequence,
          checkedAt: new Date().toISOString(), error: null };
        this.publish();
      }), batch.abort.signal);
    } catch (error) {
      if (!this.current(batch, entry.source) || this.entries.get(entry.row.key) !== entry) return;
      const unsupported = record(error) && error.code === 'history_snapshot_unsupported';
      if (!entry.snapshot) entry.row.status = unsupported ? 'unsupported' : 'error';
      entry.row.error = unsupported ? '当前配套无法核验完整历史；保留上次结果，可打开原会话查看。'
        : '本次检查失败；保留上次结果，请核对后重试。';
      this.publish();
    }
  }

  markRead(key: string, revision: number): Promise<boolean> {
    const entry = this.entries.get(key);
    if (this.disposed || !entry?.snapshot || !entry.scopeKey || entry.row.revision !== revision
      || !entry.source.isCurrent() || this.marking.has(entry.scopeKey)) return Promise.resolve(false);
    const snapshot = structuredClone(entry.snapshot), scopeKey = entry.scopeKey;
    // A subsequent check may refresh this row's source closure. An accepted
    // acknowledgement keeps its original source and binding for the final guard.
    const acknowledged: Entry = { ...entry, row: structuredClone(entry.row) };
    this.marking.add(scopeKey); this.publish();
    return this.queue(async () => {
      try {
        const cursor = await makeReadCursor(snapshot, new Date().toISOString());
        const saved = await this.store.write(scopeKey, cursor, () => this.targetCurrent(acknowledged), () => !this.disposed && acknowledged.source.isCurrent());
        if (!saved) { if (!this.disposed) this.state.feedback = '原连接或会话关系已变化，未标记已读；请重新检查。'; return false; }
        if (!this.disposed && acknowledged.source.isCurrent()) {
          for (const item of this.entries.values()) {
            if (item.scopeKey !== scopeKey || !item.snapshot) continue;
            const comparison = await compareReadCursor(item.snapshot, cursor);
            if (this.disposed || !acknowledged.source.isCurrent()) break;
            if (comparison.status === 'history-changed' && item.row.revision < acknowledged.row.revision) {
              // An older cached peer is not evidence of remote deletion after
              // acknowledging a newer snapshot of their shared session.
              item.snapshot = null;
              item.row = { ...item.row, revision: ++this.sequence, status: 'unchecked', unreadCount: null,
                error: '已读基线已在另一关联更新；请重新检查当前会话。' };
            } else item.row = { ...item.row, ...comparison };
          }
          this.state.feedback = '已标记当前检查已读；之后新增的回复仍会显示。';
        }
        return true;
      } catch {
        if (!this.disposed) this.state.feedback = '已读记录未能保存；保留原记录，请核对后重试。';
        return false;
      } finally { this.marking.delete(scopeKey); this.publish(); }
    });
  }

  cancel(): void {
    if (!this.active) return;
    this.active.abort.abort(); this.active = null; this.running = null;
    this.state.checking = false; this.state.feedback = '已停止本次检查；保留此前结果。'; this.publish();
  }

  setAutoCheck(enabled: boolean): void {
    if (this.disposed || enabled === this.state.autoCheck) return;
    this.state.autoCheck = enabled;
    if (this.autoTimer !== null) clearInterval(this.autoTimer);
    this.autoTimer = enabled ? setInterval(() => { void this.check(); }, 60000) : null;
    this.publish();
    if (enabled) void this.check();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.autoTimer !== null) clearInterval(this.autoTimer);
    this.autoTimer = null; this.active?.abort.abort(); this.active = null; this.running = null;
    this.state.checking = false; this.state.autoCheck = false; this.listeners.clear(); this.entries.clear();
  }
}
