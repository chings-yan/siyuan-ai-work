import { assertLoopbackServeUrl } from './hermes-connections.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const ASSISTANT_DETAIL_KEYS = ['reasoning', 'reasoning_content', 'reasoning_details', 'codex_reasoning_items', 'codex_message_items'];
const JSON_DETAIL_KEYS = new Set(['reasoning_details', 'codex_reasoning_items', 'codex_message_items']);
// Python's source projection uses str.strip()/re \s: include its five extra
// controls and preserve BOM, which JavaScript trim()/\s would remove.
const PYTHON_WHITESPACE = String.raw`[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;
const PYTHON_EDGE_WHITESPACE = new RegExp(`^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`, 'g');
const pythonStrip = text => text.replace(PYTHON_EDGE_WHITESPACE, '');
const MEMORY_CONTEXT_FENCE = new RegExp(String.raw`<\/?${PYTHON_WHITESPACE}*memory-context${PYTHON_WHITESPACE}*>`, 'i');
const RECALLED_MEMORY_NOTE = new RegExp(String.raw`\[System note:${PYTHON_WHITESPACE}*The following is recalled memory context,${PYTHON_WHITESPACE}*NOT new user input\.${PYTHON_WHITESPACE}*Treat as (?:informational background data|authoritative reference data[^\]]*)\.\]${PYTHON_WHITESPACE}*`, 'i');
// Python IGNORECASE also folds these four Unicode characters for ASCII patterns.
// Only the recalled-note detector sees this copy; transcript bytes stay unchanged.
const recallCasefold = text => text.replace(/[İıſK]/g, character => character === 'ſ' ? 's' : character === 'K' ? 'k' : 'i');
const SKILL_SCAFFOLD_PREFIXES = ['[IMPORTANT: The user has invoked the ', '[IMPORTANT: The "', '[/initiate-setup]'];

// Match the verified RPC property order: old v2 anchors hash this exact projection.
function historyMessage(row) {
  if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.id) || row.id <= 0) throw new Error('Hermes 历史行身份无效');
  if (row.display_kind === 'hidden' || row.role === 'tool') return null;
  if (!['user', 'assistant', 'system'].includes(row.role)) throw new Error('Hermes 历史投影不兼容');
  const content = row.display_content ?? row.content ?? '';
  if (typeof content !== 'string') throw new Error('Hermes 历史文本投影不兼容');
  const text = row.role === 'system' ? content : pythonStrip(content);
  if (row.role === 'user' && text.startsWith('[System:')) return null;
  // These exact upstream markers need additional RPC transformations. Refuse the
  // whole read rather than publish model context or let a new row bypass an old anchor.
  if ((row.role === 'user' || row.role === 'assistant') &&
      (MEMORY_CONTEXT_FENCE.test(content) || RECALLED_MEMORY_NOTE.test(recallCasefold(content)))) throw new Error('Hermes 历史文本投影不兼容');
  if (row.role === 'user' && (content.includes('\n\n[/first-task]\n\n') ||
      SKILL_SCAFFOLD_PREFIXES.some(prefix => text.startsWith(prefix)))) throw new Error('Hermes 历史文本投影不兼容');
  const details = {};
  if (row.role === 'assistant') for (const key of ASSISTANT_DETAIL_KEYS) {
    if (row[key] == null || (key !== 'reasoning_content' && row[key] === '')) continue;
    let value = row[key];
    if (JSON_DETAIL_KEYS.has(key) && typeof value === 'string') {
      try { value = JSON.parse(value); } catch { throw new Error('Hermes 历史附属字段无效'); }
    }
    if (value != null) details[key] = value;
  }
  if (!pythonStrip(text) && !Object.values(details).some(value => typeof value === 'object' ? Object.keys(value).length : Boolean(value))) return null;
  const message = { role: row.role, text };
  if (typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) && row.timestamp > 0) message.timestamp = row.timestamp;
  message.row_id = row.id;
  Object.assign(message, details);
  if (row.display_kind) message.display_kind = row.display_kind;
  if (row.display_metadata && (typeof row.display_metadata !== 'object' || Object.keys(row.display_metadata).length)) message.display_metadata = row.display_metadata;
  // These are server-projected display copies, never derived from raw provider items here.
  for (const key of ['display_commentary', 'display_reasoning']) if (row[key] != null) message[key] = row[key];
  return message;
}

export function createGatewayClient({ baseUrl, token, profile = 'default', socketFactory = url => new WebSocket(url), fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS }) {
  const url = assertLoopbackServeUrl(baseUrl);
  if (typeof token !== 'string' || !token.trim()) throw new Error('Hermes Serve 凭证缺失');
  if (typeof profile !== 'string' || !profile.trim()) throw new Error('Hermes profile 无效');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0) throw new Error('Hermes 超时配置无效');
  const wsUrl = new URL('/api/ws', url);
  wsUrl.protocol = 'ws:';
  wsUrl.search = `?token=${encodeURIComponent(token)}`;

  let socket;
  let connecting;
  let ready = false;
  let closed = false;
  let sequence = 0;
  const pending = new Map();
  const turns = new Map();
  const runtimeByStored = new Map();
  const listeners = [];
  const historyReads = new Set();

  function addListener(type, listener) {
    socket.addEventListener(type, listener);
    listeners.push([type, listener]);
  }
  function clearSocket() {
    if (socket) for (const [type, listener] of listeners.splice(0)) socket.removeEventListener?.(type, listener);
  }
  function failAll() {
    ready = false;
    runtimeByStored.clear();
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(new Error('Hermes 连接中断，操作结果未知'));
      pending.delete(id);
    }
    for (const turn of turns.values()) turn.finish({ state: 'unknown', text: turn.text });
    turns.clear();
  }
  function deliverTurnEvent(turn, event) {
    if (turn.terminal) return;
    const { type, payload } = event;
    if (type === 'message.delta' && typeof payload.text === 'string') turn.text += payload.text;
    turn.onEvent?.(event);
    if (type === 'message.complete') {
      const state = payload.status === 'complete' ? 'complete' : payload.status === 'interrupted' ? 'interrupted' : 'failed';
      turn.terminal = { state, text: typeof payload.text === 'string' ? payload.text : turn.text };
      turn.finish(turn.terminal);
    }
  }
  function flushTurnEvents(turn) {
    turn.accepted = true;
    for (const event of turn.buffer.splice(0)) deliverTurnEvent(turn, event);
  }
  function onMessage(event) {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame?.jsonrpc !== '2.0') return;
    if (frame.method === 'event') {
      const eventType = frame.params?.type;
      if (eventType === 'gateway.ready') { ready = true; connecting?.resolve(); connecting = null; return; }
      const sessionId = frame.params?.session_id;
      const turn = turns.get(sessionId);
      if (!turn) return;
      const payload = frame.params?.payload || {};
      if (eventType === 'message.delta' || eventType === 'message.complete') {
        const event = { type: eventType, sessionId, payload };
        if (!turn.accepted) turn.buffer.push(event);
        else deliverTurnEvent(turn, event);
      }
      return;
    }
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    clearTimeout(request.timer);
    if (frame.error) request.reject(Object.assign(new Error(`Hermes RPC ${request.method} 失败`), { kind: 'rejected' }));
    else request.resolve(frame.result);
  }
  async function connect() {
    if (closed) throw new Error('Hermes 连接已关闭');
    if (ready) return;
    if (connecting) return connecting.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      if (connecting?.promise !== promise) return;
      connecting = null;
      reject(new Error('Hermes 握手超时'));
      socket?.close();
    }, timeoutMs);
    connecting = { promise, resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
    try {
      socket = socketFactory(wsUrl.href);
      addListener('message', onMessage);
      addListener('error', () => {
        connecting?.reject(new Error('Hermes WebSocket 握手失败'));
        connecting = null;
        failAll();
        clearSocket();
      });
      addListener('close', () => {
        connecting?.reject(new Error('Hermes WebSocket 已断开'));
        connecting = null;
        failAll();
        clearSocket();
      });
    } catch {
      clearTimeout(timer);
      connecting = null;
      throw new Error('Hermes WebSocket 连接失败');
    }
    return promise;
  }
  async function rpc(method, params = {}, signal) {
    await connect();
    if (signal?.aborted) throw Object.assign(new Error('Hermes 请求已取消'), { kind: 'aborted' });
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); pending.delete(id); signal?.removeEventListener('abort', abort); };
      const yes = value => { cleanup(); resolve(value); };
      const no = error => { cleanup(); reject(error); };
      const abort = () => no(Object.assign(new Error('Hermes 请求已取消，操作结果未知'), { kind: 'aborted' }));
      timer = setTimeout(() => no(new Error(`Hermes RPC ${method} 超时，操作结果未知`)), timeoutMs);
      pending.set(id, { method, resolve: yes, reject: no, timer });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: { profile, ...params } })); }
      catch { no(new Error(`Hermes RPC ${method} 发送失败，操作结果未知`)); }
    });
  }

  const client = {
    ping: () => rpc('gateway.ping'),
    list: () => rpc('session.list'),
    async create(title) {
      const result = await rpc('session.create', { title, source: 'siyuan-ai-collab', close_on_disconnect: false });
      if (typeof result?.session_id !== 'string' || typeof result?.stored_session_id !== 'string') throw new Error('Hermes 创建会话响应无效');
      runtimeByStored.set(result.stored_session_id, result.session_id);
      return { runtimeSessionId: result.session_id, storedSessionId: result.stored_session_id };
    },
    async resume(storedSessionId) {
      const result = await rpc('session.resume', { session_id: storedSessionId, source: 'siyuan-ai-collab', close_on_disconnect: false });
      if (typeof result?.session_id !== 'string') throw new Error('Hermes 恢复会话响应无效');
      runtimeByStored.set(storedSessionId, result.session_id);
      return result.session_id;
    },
    async history(storedSessionId, { captureSnapshotRecords = false } = {}) {
      if (closed) throw new Error('Hermes 连接已关闭');
      if (typeof storedSessionId !== 'string' || !storedSessionId.trim()) throw new Error('Hermes 历史会话身份无效');
      const controller = new AbortController();
      let rejectRead;
      const cancelled = new Promise((_, reject) => { rejectRead = reject; });
      const stop = () => { controller.abort(); rejectRead(new Error('Hermes 历史读取失败')); };
      historyReads.add(stop);
      const timer = setTimeout(() => { controller.abort(); rejectRead(new Error('Hermes 历史读取超时')); }, timeoutMs);
      const read = async () => {
        const messages = [], snapshotRecords = [];
        const rowIds = new Set();
        for (let page = 0; page < 100; page++) {
          const offset = page * 500;
          const endpoint = new URL(`/api/sessions/${encodeURIComponent(storedSessionId)}/messages`, url);
          endpoint.search = new URLSearchParams({ profile, limit: '500', offset: String(offset), order: 'oldest', inline_images: 'false' }).toString();
          const response = await fetchImpl(endpoint, { method: 'GET', headers: { 'X-Hermes-Session-Token': token }, redirect: 'error', signal: controller.signal });
          if (controller.signal.aborted || !response.ok || response.redirected || response.status >= 300) throw new Error('Hermes 历史读取失败');
          const body = await response.json();
          const pagination = body?.pagination;
          if (body?.session_id !== storedSessionId || body?.profile !== profile || !Array.isArray(body?.messages) ||
            pagination?.limit !== 500 || pagination?.offset !== offset || pagination?.order !== 'oldest' ||
            !Number.isInteger(pagination?.returned) || pagination.returned < 0 || pagination.returned > 500 || pagination.returned !== body.messages.length) {
            throw new Error('Hermes 历史身份或分页无效');
          }
          for (const row of body.messages) {
            const message = historyMessage(row);
            if (rowIds.has(row.id)) throw new Error('Hermes 历史行重复');
            rowIds.add(row.id);
            if (captureSnapshotRecords) {
              if (!['user', 'assistant', 'system', 'tool'].includes(row.role) || typeof row.content !== 'string') throw new Error('Hermes 快照源行不兼容');
              snapshotRecords.push(row);
            }
            if (message) messages.push(message);
          }
          // Official REST projection is one-to-one, even for hidden/tool rows.
          if (pagination.returned < 500) return { count: messages.length, messages, ...(captureSnapshotRecords ? { snapshotRecords } : {}) };
        }
        throw new Error('Hermes 历史超过读取上限');
      };
      try { return await Promise.race([read(), cancelled]); }
      catch { throw new Error(controller.signal.aborted ? 'Hermes 历史读取超时或已关闭' : 'Hermes 历史读取失败，身份或投影无法核实'); }
      finally { clearTimeout(timer); historyReads.delete(stop); controller.abort(); }
    },
    async submit(runtimeSessionId, text, { onEvent, onAccepted, signal } = {}) {
      if (signal?.aborted) return { state: 'unknown', text: '' };
      try { await connect(); }
      catch { return { state: 'unknown', text: '' }; }
      if (signal?.aborted) return { state: 'unknown', text: '' };
      if (turns.has(runtimeSessionId)) throw new Error('同一会话已有未完成提交');
      let finish;
      const completion = new Promise(resolve => { finish = resolve; });
      const turn = { text: '', userRowId: undefined, terminal: null, accepted: false, buffer: [], onEvent, finish };
      turns.set(runtimeSessionId, turn);
      const abort = () => { turn.finish({ state: 'unknown', text: turn.text }); turns.delete(runtimeSessionId); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await rpc('prompt.submit', { session_id: runtimeSessionId, text, queued: true }, signal);
        if (typeof result?.user_row_id === 'number') turn.userRowId = result.user_row_id;
        if (result?.status === 'queued') {
          turn.buffer.length = 0;
          return { state: 'queued', text: '', ...(turn.userRowId == null ? {} : { userRowId: turn.userRowId }) };
        }
        if (result?.status !== 'streaming') return { state: 'failed', text: '' };
        if (turn.userRowId != null && !signal?.aborted && !turn.buffer.some(event => event.type === 'message.complete')) onAccepted?.({ status: 'streaming', userRowId: turn.userRowId });
        flushTurnEvents(turn);
        if (turn.terminal) return { ...turn.terminal, ...(turn.userRowId == null ? {} : { userRowId: turn.userRowId }) };
        let terminalTimer;
        try {
          terminalTimer = setTimeout(() => turn.finish({ state: 'unknown', text: turn.text }), turnTimeoutMs);
          const terminal = await completion;
          return { ...terminal, ...(turn.userRowId == null ? {} : { userRowId: turn.userRowId }) };
        } finally { clearTimeout(terminalTimer); }
      } catch (error) {
        if (signal?.aborted) return { state: 'unknown', text: turn.text };
        // Without a queued acknowledgement, a confirmed terminal remains authoritative.
        flushTurnEvents(turn);
        if (turn.terminal) return { ...turn.terminal, ...(turn.userRowId == null ? {} : { userRowId: turn.userRowId }) };
        return { state: error?.kind === 'rejected' ? 'failed' : 'unknown', text: turn.text };
      }
      finally { turns.delete(runtimeSessionId); signal?.removeEventListener('abort', abort); }
    },
    interrupt: runtimeSessionId => rpc('session.interrupt', { session_id: runtimeSessionId }),
    close() {
      if (closed) return;
      closed = true;
      connecting?.reject(new Error('Hermes 连接已关闭'));
      connecting = null;
      failAll();
      for (const stop of historyReads) stop();
      clearSocket();
      socket?.close();
    },
  };
  return client;
}
