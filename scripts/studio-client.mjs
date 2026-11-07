import { readFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertSessionRun } from './hermes-session-run-record.mjs';
import { assertSnapshotActive } from './hermes-history-snapshot.mjs';

// Only absent ownership without exact index evidence is unresolved. Explicit
// invalid or contradictory profiles are a separate protocol validation failure.
export function isUnresolvedStudioSession(row, indexProfiles) {
  return row !== null && typeof row === 'object' && !Array.isArray(row) &&
    typeof row.id === 'string' && Boolean(row.id.trim()) &&
    !Object.hasOwn(row, 'profile') && !indexProfiles.has(row.id);
}

export function normalizeStudioSessions(body) {
  const rows = Array.isArray(body) ? body : (body?.sessions ?? body?.data ?? []);
  return rows.filter(s => s && s.profile === 'default' && typeof s.id === 'string').map(s => ({
    id: s.id,
    title: String(s.title ?? ''),
    preview: String(s.preview ?? ''),
    last_active: s.last_active ?? s.lastActive ?? null,
    message_count: Number.isFinite(Number(s.message_count)) ? Number(s.message_count) : 0,
    source: 'studio',
    profile: 'default'
  }));
}

export function normalizeStudioMessages(body, sessionId) {
  const rows = Array.isArray(body) ? body : (body?.messages ?? body?.data ?? []);
  return { session_id: sessionId, data: rows.filter(m => m && (m.role === 'user' || m.role === 'assistant')).map(m => {
    const result = { id: m.id == null ? undefined : String(m.id), role: m.role, content: String(m.content ?? '') };
    const timestamp = m.timestamp ?? m.created_at;
    if (timestamp !== undefined) result.timestamp = timestamp;
    return result;
  }) };
}

export function buildRunPayload({ sessionId, input, instructions = '' }) {
  return { input, display_input: input, storage_message: input, session_id: sessionId, profile: 'default', instructions };
}

export function validateDocumentTitle(title) { return typeof title === 'string' && title.length > 0 && title.length <= 200 && !/[\r\n]/.test(title); }

export function safeBinding(binding) {
  return { id: String(binding.id), title: String(binding.title ?? ''), documentRootId: String(binding.documentRootId), updatedAt: String(binding.updatedAt ?? new Date().toISOString()) };
}

export async function readBindings(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error('Bridge 绑定数据损坏；已停止写入，请从备份恢复'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bridge 绑定数据格式错误；已停止写入');
  for (const [key, row] of Object.entries(value)) if (row && Object.hasOwn(row, 'run')) assertSessionRun(row.run, row, key, 'legacy');
  return value;
}
export async function writeBindingsAtomic(file, value) { await mkdir(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; const { writeFile } = await import('node:fs/promises'); await writeFile(tmp, JSON.stringify(value), { encoding:'utf8', mode:0o600 }); await rename(tmp, file); }

export async function runStudioSocket({ studioBase, token, tokenProvider, payload, onEvent, signal, canAbort = () => true, socketFactory, timeoutMs = 120000, abortGraceMs = 5000, maxAuthRetries = 1 }) {
  const factory = socketFactory || (await import('socket.io-client')).io;
  return await new Promise((resolve, reject) => {
    let done = false; let socket; let timer; let abortTimer; let authRetries = 0; let aborting = false; let accepted = false; let sent = false;
    const events = ['run.started','message.delta','reasoning.delta','thinking.delta','tool.started','tool.output','tool.completed','approval.requested','clarify.requested','run.completed','run.failed','abort.started','abort.completed','abort.timeout'];
    const registrations = new Map();
    const cleanupSocket = (candidate) => {
      for (const [event, callback] of registrations) candidate?.off?.(event, callback);
      candidate?.removeAllListeners?.();
      registrations.clear();
      candidate?.disconnect?.();
    };
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(timer); clearTimeout(abortTimer); signal?.removeEventListener('abort', abort); cleanupSocket(socket); fn(value); };
    const abort = () => {
      if (done || aborting) return;
      aborting = true;
      // Local transport cancellation is not permission to stop a shared session.
      // The Bridge additionally requires its accepted, still-live owned lease.
      if (!socket || !accepted || !canAbort()) { finish(reject, new DOMException('The operation was aborted', 'AbortError')); return; }
      socket.emit('abort', {session_id:payload.session_id});
      abortTimer = setTimeout(() => finish(reject, new DOMException('The operation was aborted', 'AbortError')), abortGraceMs);
    };
    const isAuthError = (e) => /auth|unauthor|token|credential/i.test(String(e?.message || e?.code || ''));
    const register = (candidate, event, callback) => { registrations.set(event, callback); candidate.on(event, callback); };
    const attach = (candidate) => {
      if (done) { candidate.disconnect?.(); return; }
      cleanupSocket(socket); socket = candidate; accepted = false;
      for (const event of events) register(candidate, event, data => { if (done || candidate !== socket) return; if (event === 'run.started') { if (aborting) return; accepted = true; } if (['run.completed', 'run.failed', 'abort.completed', 'abort.timeout'].includes(event)) accepted = false; onEvent?.(event, data); if (event === 'run.completed') finish(resolve, data); if (event === 'run.failed') finish(reject, new Error(String(data?.error || 'Studio run failed'))); if (event === 'abort.completed' || event === 'abort.timeout') finish(reject, new DOMException('The operation was aborted', 'AbortError')); });
      register(candidate, 'connect', () => {
        if (done || aborting || candidate !== socket) return;
        // A reconnect cannot prove the previous send was unaccepted. Keep the
        // durable unknown barrier instead of replaying a business request.
        if (sent) { finish(reject, new Error('Studio connection changed after send')); return; }
        sent = true; candidate.emit('run', payload);
      });
      register(candidate, 'connect_error', async e => {
        if (done || candidate !== socket) return;
        if (sent) { finish(reject, e); return; }
        if (!aborting && tokenProvider && isAuthError(e) && authRetries < maxAuthRetries) {
          authRetries++; accepted = false; socket = undefined; cleanupSocket(candidate);
          try { const current = await tokenProvider(); if (!done && !aborting) attach(factory(`${studioBase}/chat-run`, { auth:{token:current}, transports:['websocket'] })); }
          catch (error) { finish(reject, error); }
          return;
        }
        finish(reject, e);
      });
    };
    timer = setTimeout(() => finish(reject, new Error('Studio run timed out')), timeoutMs);
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
    if (done) return;
    Promise.resolve(tokenProvider?.() ?? token).then(current => { if (!done) attach(factory(`${studioBase}/chat-run`, { auth:{token:current}, transports:['websocket'] })); }, error => finish(reject, error));
  });
}

// Separate from the compatibility display reader below: missing metadata is
// acceptable for old display, but cannot establish a durable unread cursor.
export async function fetchStudioMessagesSnapshot({ sessionId, profile, fetchPage, limit = 200, maxPages = 100, signal }) {
  const fail = () => { throw Object.assign(new Error('Studio history snapshot unverified'), { code: 'history_snapshot_unverified' }); };
  if (typeof sessionId !== 'string' || !sessionId || typeof profile !== 'string' || !profile
    || !Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(maxPages) || maxPages <= 0) fail();
  const records = [], ids = new Set();
  let total, offset = 0;
  for (let count = 0; count < maxPages; count++) {
    assertSnapshotActive(signal);
    const page = await fetchPage(offset, limit, signal);
    assertSnapshotActive(signal);
    if (!page || page.session?.id !== sessionId || page.session?.profile !== profile || !Array.isArray(page.messages)
      || !Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== offset || page.limit !== limit
      || typeof page.hasMore !== 'boolean' || (total !== undefined && total !== page.total)
      || page.messages.length !== Math.min(limit, page.total - offset)
      || page.hasMore !== (offset + page.messages.length < page.total)) fail();
    total = page.total;
    for (const row of page.messages) {
      if (!row || !Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id) || row.session_id !== sessionId
        || !['user', 'assistant', 'system', 'tool', 'command', 'moa'].includes(row.role) || typeof row.content !== 'string') fail();
      ids.add(row.id); records.push(row);
    }
    if (!page.hasMore) return { records };
    offset += page.messages.length;
  }
  fail();
}

export async function fetchStudioMessagesPaginated({ sessionId, fetchPage, limit = 200, maxPages = 100 }) {
  const messages = []; const seen = new Set(); let offset = 0; let pageCount = 0;
  while (true) {
    if (pageCount++ >= maxPages) throw new Error('Studio message pagination exceeded maximum page limit');
    const page = await fetchPage(offset, limit); const rows = Array.isArray(page?.messages) ? page.messages : [];
    for (const message of rows) { const key = message?.id == null ? JSON.stringify(message) : String(message.id); if (!seen.has(key)) { seen.add(key); messages.push(message); } }
    if (page?.hasMore !== true) return { session_id:sessionId, messages, total:page?.total, offset:0, limit };
    const next = Number(page?.offset) + Number(page?.limit || limit); if (!Number.isFinite(next) || next <= offset) throw new Error('Studio message pagination returned an invalid offset'); offset = next;
  }
}

export async function fetchStudioSessionsPaginated({ fetchPage, limit = 200, maxPages = 100 }) {
  const sessions = []; const seen = new Set(); let offset = 0; let pageCount = 0;
  while (true) {
    if (pageCount++ >= maxPages) throw new Error('Studio session pagination exceeded maximum page limit');
    const page = await fetchPage(offset, limit);
    const rows = Array.isArray(page?.sessions) ? page.sessions : [];
    for (const session of rows) {
      const key = session?.id == null ? JSON.stringify(session) : String(session.id);
      if (!seen.has(key)) { seen.add(key); sessions.push(session); }
    }
    if (page?.hasMore !== true) return sessions;
    const pageOffset = Number(page?.offset); const pageLimit = Number(page?.limit);
    const next = pageOffset + pageLimit;
    if (!Number.isFinite(next) || !Number.isFinite(pageOffset) || !Number.isFinite(pageLimit) || pageLimit <= 0 || next <= offset) throw new Error('Studio session pagination returned an invalid offset');
    offset = next;
  }
}
