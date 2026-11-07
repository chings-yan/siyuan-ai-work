import type { StoragePort } from './store.ts';

type Options = {
  request?: typeof fetch;
  timeoutMs?: number;
  appId?: () => string;
  onSaved?: (key: string, value: unknown) => void;
};

const ROOT = '/data/storage/petal/siyuan-ai-collab/';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 128;
const JSON_BUDGET_MS = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const invalid = () => new Error('插件存储未能核实；请先核对保存状态，勿重复操作');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function pathFor(key: string): string {
  if (typeof key !== 'string' || !/^[a-z0-9_-]{1,160}$/.test(key)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(key)) throw invalid();
  return ROOT + key;
}

/** One budget includes request headers, streamed bodies, parsing and readback. */
class Deadline {
  readonly controller = new AbortController();
  private readonly until: number;
  private readonly expired: Promise<never>;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(timeoutMs: number) {
    this.until = performance.now() + timeoutMs;
    let expire!: (error: Error) => void;
    this.expired = new Promise<never>((_resolve, reject) => { expire = reject; });
    this.timer = setTimeout(() => { this.abort(); expire(invalid()); }, timeoutMs);
    // A synchronous validation failure can happen before the first async step.
    void this.expired.catch(() => {});
  }

  check(): void {
    if (this.controller.signal.aborted || performance.now() >= this.until) { this.abort(); throw invalid(); }
  }
  abort(): void { this.controller.abort(); }
  close(): void { clearTimeout(this.timer); }
  async step<T>(start: () => T | PromiseLike<T>): Promise<T> {
    this.check();
    const result = await Promise.race([Promise.resolve(start()), this.expired]);
    // Abort-ignoring transports and a blocked event loop must not start a next step.
    this.check();
    return result;
  }
}

function jsonBudget(deadline: Deadline): () => void {
  const start = performance.now();
  return () => { deadline.check(); if (performance.now() - start > JSON_BUDGET_MS) throw invalid(); };
}

function dataValue(value: unknown): boolean {
  return typeof value === 'string' || (record(value) && !Object.hasOwn(value, 'code'));
}

/** Snapshot only JSON data; accessors/toJSON and lossy values cannot alter an intent. */
function freezeJson(value: unknown, check: () => void, ancestors = new Set<object>(), depth = 0): unknown {
  check();
  if (depth > MAX_DEPTH) throw invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw invalid();
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw invalid();
  ancestors.add(value);
  const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
  const keys = Object.keys(value);
  if (Array.isArray(value) && keys.length !== value.length) throw invalid();
  if (Object.getOwnPropertySymbols(value).length) throw invalid();
  for (const key of keys) {
    check();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw invalid();
    if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) throw invalid();
    Object.defineProperty(result, key, { value: freezeJson(descriptor.value, check, ancestors, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return Object.freeze(result);
}

function equalJson(left: unknown, right: unknown, check: () => void, depth = 0): boolean {
  check();
  if (depth > MAX_DEPTH) throw invalid();
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left), other = Object.keys(right);
  if (keys.length !== other.length) return false;
  return keys.every(key => Object.hasOwn(right, key) && equalJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], check, depth + 1));
}

async function readJson(response: Response, deadline: Deadline): Promise<unknown> {
  deadline.check();
  if (Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  const pieces: string[] = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const chunk = await deadline.step(() => reader.read());
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) throw invalid();
      pieces.push(decoder.decode(chunk.value, { stream: true }));
    }
    pieces.push(decoder.decode());
    deadline.check();
    const check = jsonBudget(deadline);
    const value: unknown = JSON.parse(pieces.join(''));
    check();
    complete = true;
    return value;
  } finally {
    if (!complete) {
      deadline.abort();
      // Neither an ignored abort nor a hung stream cancel can delay settlement.
      try { void reader.cancel().catch(() => {}); } catch { /* already closed */ }
    }
    try { reader.releaseLock(); } catch { /* an ignored-abort read may still be pending */ }
  }
}

export class CheckedPluginStorage implements StoragePort {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly appId?: () => string;
  private readonly onSaved?: (key: string, value: unknown) => void;
  // An uncertain physical write must not be overwritten by a later operation.
  // This is an instance-local fence, not a cross-window/device transaction.
  private readonly unverified = new Set<string>();

  constructor(options: Options = {}) {
    this.request = options.request ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) throw invalid();
    this.appId = options.appId;
    this.onSaved = options.onSaved;
  }

  private async fetch(url: string, init: RequestInit, deadline: Deadline): Promise<Response> {
    const response = await deadline.step(() => this.request(url, {
      ...init, method: 'POST', cache: 'no-store', redirect: 'error', mode: 'same-origin',
      credentials: 'same-origin', signal: deadline.controller.signal,
    }));
    if (response.redirected || response.type === 'opaqueredirect') throw invalid();
    return response;
  }

  private async read(path: string, deadline: Deadline): Promise<unknown> {
    const response = await this.fetch('/api/file/getFile', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) }, deadline);
    if (![200, 202, 404].includes(response.status)) throw invalid();
    const value = await readJson(response, deadline);
    if ((response.status === 202 || response.status === 404) && record(value) && value.code === 404) return undefined;
    if (response.status !== 200 || !dataValue(value)) throw invalid();
    return value;
  }

  async loadData(key: string): Promise<unknown> {
    const path = pathFor(key), deadline = new Deadline(this.timeoutMs);
    try { return await this.read(path, deadline); }
    catch { deadline.abort(); throw invalid(); }
    finally { deadline.close(); }
  }

  async saveData(key: string, value: unknown): Promise<void> {
    const path = pathFor(key);
    if (this.unverified.has(key)) throw invalid();
    const deadline = new Deadline(this.timeoutMs);
    try {
      if (!dataValue(value)) throw invalid();
      const check = jsonBudget(deadline);
      const frozen = freezeJson(value, check);
      const text = JSON.stringify(frozen);
      check();
      const file = new Blob([text], { type: 'application/json' });
      if (file.size > MAX_BYTES) throw invalid();
      const form = new FormData();
      form.append('path', path); form.append('isDir', 'false'); form.append('file', file, key);
      if (this.appId) {
        const app = this.appId();
        if (typeof app !== 'string' || !app.trim()) throw invalid();
        form.append('app', app);
      }
      deadline.check();
      this.unverified.add(key);
      const response = await this.fetch('/api/file/putFile', { body: form }, deadline);
      if (response.status !== 200) throw invalid();
      const receipt = await readJson(response, deadline);
      if (!record(receipt) || receipt.code !== 0) throw invalid();
      const actual = await this.read(path, deadline);
      if (!equalJson(frozen, actual, jsonBudget(deadline))) throw invalid();
      deadline.check();
      this.onSaved?.(key, frozen);
      this.unverified.delete(key);
    } catch { deadline.abort(); throw invalid(); }
    finally { deadline.close(); }
  }
}
