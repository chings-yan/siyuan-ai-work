import { createServer } from 'node:http';
import { createEkkoRouteHandler } from './ekko-routes.mjs';
import { bridgeMetadata } from './bridge-metadata.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBridgeConfig, loadBridgeEnvironment } from './bridge-config.mjs';
import { readBindings, normalizeStudioSessions, normalizeStudioMessages, buildRunPayload, validateDocumentTitle, safeBinding, runStudioSocket, fetchStudioMessagesPaginated, fetchStudioMessagesSnapshot, fetchStudioSessionsPaginated, isUnresolvedStudioSession } from './studio-client.mjs';
import { snapshotError, assertSnapshotActive, withSnapshotDeadline, captureHistorySnapshot, snapshotDisplayMessages } from './hermes-history-snapshot.mjs';
import { connectionRegistry, readServeToken, probeServe, probeStudio, probeLegacy, assertLoopbackServeUrl } from './hermes-connections.mjs';
import { createSessionRunCoordinator } from './hermes-session-runs.mjs';
import { createGatewayClient } from './hermes-gateway-client.mjs';
import { readChatBindings, mutateChatBindings, mutateLegacyBindings, assertChatScope, validChatId } from './bridge-chat-store.mjs';

export function hermesEnvPath(env = process.env) {
  return resolveBridgeConfig(env).envFile;
}

export const DEFAULT_ORIGINS = ['http://127.0.0.1:6806', 'http://localhost:6806'];
export function allowedOrigin(origin, origins = DEFAULT_ORIGINS) {
  return typeof origin === 'string' && origins.includes(origin) ? origin : null;
}
export function corsHeaders(origin, origins = DEFAULT_ORIGINS) {
  const allowed = allowedOrigin(origin, origins);
  return allowed ? { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Siyuan-Collab-Token,X-Siyuan-Document-Root,X-Ekko-Connection-Id,X-Ekko-Device-Id,X-Ekko-Account-User-Id' } : { Vary: 'Origin' };
}
export function authorize(req, capability, origins = DEFAULT_ORIGINS) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin, origins)) return { ok: false, status: 403, code: 'origin_denied' };
  if (typeof capability === 'string' && capability.length >= 64 && req.headers['x-siyuan-collab-token'] === capability) return { ok: true };
  return { ok: false, status: 401, code: 'unauthorized' };
}

export function requestHeaderProfile(headers) {
  const ua = String(headers['user-agent'] || '').toLowerCase();
  return { originPresent: Boolean(headers.origin), refererHost: (() => { try { return headers.referer ? new URL(headers.referer).host : null; } catch { return 'invalid'; } })(), secFetchSite: headers['sec-fetch-site'] ? String(headers['sec-fetch-site']) : null, userAgentClass: ua.includes('electron') ? 'electron' : ua.includes('chrome') ? 'chrome' : ua ? 'other' : 'missing' };
}

export function validateOwnedSession(session, documentRootId) {
  return Boolean(documentRootId && session && typeof session.title === 'string' && session.title.startsWith(`siyuan:${documentRootId}:`));
}
export function filterOwnedSessions(sessions, documentRootId) {
  return Array.isArray(sessions) ? sessions.filter(session => validateOwnedSession(session, documentRootId)) : [];
}

function json(res, status, body, origin, origins) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(origin, origins) });
  res.end(JSON.stringify(body));
}
async function readBody(req) { let s = ''; for await (const c of req) s += c; if (s.length > 2_000_000) throw new Error('request too large'); return s ? JSON.parse(s) : {}; }
function pathId(id) { return encodeURIComponent(id); }

function loadCapability() {
  if (process.env.SIYUAN_BRIDGE_TOKEN && !process.env.SIYUAN_BRIDGE_TOKEN_FILE) return process.env.SIYUAN_BRIDGE_TOKEN;
  const file = resolveBridgeConfig().tokenFile;
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  return process.env.SIYUAN_BRIDGE_TOKEN || '';
}

export function studioTokenPath(env = process.env) {
  return resolveBridgeConfig(env).studioTokenFile;
}

export function loadStudioToken(env = process.env) {
  const file = studioTokenPath(env);
  try { return readFileSync(file, 'utf8').trim(); } catch { return env.HERMES_STUDIO_TOKEN || ''; }
}

export function findBinding(bindings, documentRootId, sessionId) {
  const binding = bindings?.[`${documentRootId}:${sessionId}`];
  return binding?.id === sessionId && binding.documentRootId === documentRootId && binding.profile === 'default' ? binding : null;
}
export function mergeVisibleSessions(legacy, studio, bindings, documentRootId) {
  const owned = legacy.filter(s => s?.id && validateOwnedSession(s, documentRootId));
  const current = Object.values(bindings || {}).filter(b => b?.documentRootId === documentRootId && b?.profile === 'default');
  const visible = [...owned, ...studio.filter(s => s?.id), ...current];
  return [...new Map(visible.map(s => [s.id, s])).values()];
}

async function pingServe(connection, token, signal) {
  const url = new URL('/api/ws', connection.baseUrl);
  url.protocol = 'ws:';
  url.search = `?token=${encodeURIComponent(token)}`;
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    let done = false; let sent = false; let timer;
    const finish = (callback, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.removeEventListener('error', error);
      socket.removeEventListener('close', close);
      socket.removeEventListener('message', message);
      socket.close();
      callback(value);
    };
    const error = () => finish(reject, new Error('Hermes ping failed'));
    const close = () => finish(reject, new Error('Hermes ping closed'));
    const abort = () => finish(reject, Object.assign(new Error('Hermes inspection timed out'), { probeState: 'offline' }));
    const message = event => {
      let frame;
      try { frame = JSON.parse(event.data); }
      catch { finish(reject, new Error('Hermes ping protocol invalid')); return; }
      if (frame?.jsonrpc !== '2.0') { finish(reject, new Error('Hermes ping protocol invalid')); return; }
      if (!sent && frame.method === 'event' && frame.params?.type === 'gateway.ready') {
        sent = true;
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'gateway.ping', params: { profile: connection.profile } }));
      }
      if (frame.id === 1) {
        if (!sent || frame.error) finish(reject, new Error('Hermes ping rejected'));
        else finish(resolve, frame.result);
      }
    };
    timer = setTimeout(abort, 5000);
    socket.addEventListener('error', error, { once: true });
    socket.addEventListener('close', close, { once: true });
    socket.addEventListener('message', message);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function createBridgeServer({ fetchImpl = fetch, capability = loadCapability(), hermesBase = (process.env.HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/$/, ''), studioBase = (process.env.HERMES_STUDIO_URL || 'http://127.0.0.1:8748').replace(/\/$/, ''), studioToken, tokenProvider, probeTimeoutMs = 5_000, snapshotTimeoutMs = 10_000, studioRun = runStudioSocket, bindingsFile = resolveBridgeConfig().bindingsFile, bindingsV2File = process.env.SIYUAN_BRIDGE_BINDINGS_V2_FILE || join(dirname(bindingsFile), 'siyuan-ai-collab-bindings-v2.json'), origins = DEFAULT_ORIGINS, ekko = {}, connections = connectionRegistry(), gatewayFactory = ({ connection, token }) => ({ ...createGatewayClient({ baseUrl: connection.baseUrl, token, profile: connection.profile, fetchImpl }), ping: ({ signal } = {}) => pingServe(connection, token, signal) }) } = {}) {
  const ekkoRoutes = createEkkoRouteHandler({ fetchImpl, ...ekko });
  const activeChats = new Set();
  const sessionRuntime = new Map();
  const runs = createSessionRunCoordinator({ bindingsV2File, bindingsFile });
  const runOwner = binding => ({ kind: 'v2', chatId: binding.chatId, documentRootId: binding.documentRootId });
  const runIdentity = binding => Object.fromEntries(['connectionId', 'kind', 'profile', 'storedSessionId', 'installId'].map(key => [key, binding[key]]));
  const legacyRunIdentity = binding => {
    const matches = connections.connections.filter(item => item.kind === 'studio' && item.profile === binding.profile);
    if (binding.source !== 'studio' || matches.length !== 1) throw chatError(409, 'session_identity_unknown', '会话运行身份待核对');
    return { connectionId: matches[0].id, kind: 'studio', profile: binding.profile, storedSessionId: binding.id, installId: null };
  };
  const terminalReceipt = (source, terminal) => ({ source, terminal, verified: true });
  const connectionById = id => connections.connections.find(item => item.id === id);
  const chatError = (status, code, message) => Object.assign(new Error(message), { status, code });
  const safeErrors = new Map(Object.entries({
    chat_scope_denied: [403, 'Chat 不属于当前文档'], chat_not_found: [404, 'Chat 不存在'],
    connection_changed: [409, '连接配置已变化'], install_changed: [409, 'Hermes 安装标识已变化'],
    history_anchor_mismatch: [409, 'Hermes 历史锚点不匹配'], connection_not_found: [404, '连接不存在'],
    legacy_sessions_failed: [503, '旧 API 会话读取失败'], invalid_chat: [400, 'Chat 参数无效'],
    legacy_create_unsupported: [400, '旧 API 连接不支持新建 Chat'], chat_conflict: [409, 'Chat 标识已绑定'],
    selection_required: [400, '需要用户明确确认关联'], invalid_binding: [400, '关联参数无效'],
    session_claimed: [409, '会话已属于其他文档'], session_not_found: [404, '会话不存在'],
    session_scope_denied: [403, '会话归属无法验证'], chat_busy: [409, 'Chat 正在处理'],
    chat_result_unknown: [409, '上一轮结果未核实'], empty_message: [400, '消息不能为空'],
    studio_history_failed: [503, 'Studio 历史读取失败'], auth_missing: [401, 'Hermes Serve 凭证缺失'],
    auth_failed: [401, 'Hermes Serve 认证失败'], offline: [503, 'Hermes Serve 不可用'],
    incompatible: [503, 'Hermes Serve 协议不兼容'],
    session_busy: [409, '这段对话正在处理'], session_result_unknown: [409, '上次运行结果待核对'],
    session_identity_unknown: [409, '会话运行身份待核对'],
    history_snapshot_unsupported: [422, '此历史来源暂不支持核验回复进度'],
    history_snapshot_unverified: [503, '历史完整性尚未核验；回复进度保持原样'],
    history_snapshot_changed: [409, '历史或关联正在变化；回复进度保持原样'],
    history_snapshot_timeout: [504, '历史核验超时；回复进度保持原样'],
  }));
  const assertStudioClaim = (old, id, root, profile = 'default') => {
    const previous = old[`${root}:${id}`];
    if (previous && (previous.id !== id || previous.documentRootId !== root || previous.profile !== profile || previous.source !== 'studio')) throw chatError(409, 'chat_conflict', '原 Studio 关联身份不符');
  };
  const sameBindingIdentity = (a, b) => ['chatId', 'connectionId', 'kind', 'profile', 'storedSessionId', 'installId', 'documentRootId'].every(key => a[key] === b[key]);
  const assertV2Claim = (current, requested) => {
    if (Object.values(current).some(binding => binding.chatId !== requested.chatId && binding.connectionId === requested.connectionId && binding.storedSessionId === requested.storedSessionId
      && (requested.kind === 'legacy-api' || binding.documentRootId === requested.documentRootId && binding.kind === requested.kind && binding.profile === requested.profile && binding.installId === requested.installId))) throw chatError(409, 'session_claimed', '会话已有关联入口');
  };
  const publicChat = binding => ({ chatId: binding.chatId, connectionId: binding.connectionId, kind: binding.kind, profile: binding.profile, documentRootId: binding.documentRootId, title: binding.title, state: binding.state, storedSessionId: binding.storedSessionId, installId: binding.installId });
  const messageId = message => message?.id == null ? (message?.row_id == null ? null : String(message.row_id)) : String(message.id);
  const anchorOf = message => ({ messageId: messageId(message), sha256: createHash('sha256').update(JSON.stringify(message)).digest('hex') });
  const checkAnchor = (binding, messages) => {
    if (!binding.anchor) return;
    const matched = messages.find(message => messageId(message) === binding.anchor.messageId);
    if (!matched || anchorOf(matched).sha256 !== binding.anchor.sha256) throw chatError(409, 'history_anchor_mismatch', 'Hermes 历史锚点不匹配');
  };
  const saveChat = (chatId, update) => mutateChatBindings(bindingsV2File, current => {
    const existing = current[chatId];
    if (!existing) throw chatError(404, 'chat_not_found', 'Chat 不存在');
    return { ...current, [chatId]: { ...existing, ...update } };
  });
  const liveChat = async chatId => {
    const bindings = await readChatBindings(bindingsV2File);
    let binding = bindings[chatId];
    if (!binding) throw chatError(404, 'chat_not_found', 'Chat 不存在');
    if (binding.state === 'creating' && !activeChats.has(chatId)) {
      await saveChat(chatId, { state: 'unknown' });
      binding = { ...binding, state: 'unknown' };
    }
    return binding;
  };
  const probeConnection = connection => probeServe(connection, { fetchImpl, timeoutMs: probeTimeoutMs, rpcProbe: async (_, { method, token, signal }) => {
    const gateway = gatewayFactory({ connection, token, profile: connection.profile, fetchImpl });
    let closed = false;
    const close = () => { if (!closed) { closed = true; gateway.close?.(); } };
    signal.addEventListener('abort', close, { once: true });
    try {
      return await (method === 'gateway.ping' ? gateway.ping({ signal }) : gateway.list());
    } finally { signal.removeEventListener('abort', close); close(); }
  } });
  const serveIdentity = async connection => {
    const result = await probeConnection(connection);
    if (result.state !== 'ready') throw chatError(result.state.startsWith('auth_') ? 401 : 503, result.state, 'Hermes Serve 未就绪');
    return result.installId;
  };
  const verifyConnection = async binding => {
    const connection = connectionById(binding.connectionId);
    if (!connection || connection.profile !== binding.profile || connection.kind !== binding.kind) throw chatError(409, 'connection_changed', '连接配置已变化');
    if (connection.kind === 'serve') {
      const currentInstallId = await serveIdentity(connection);
      if (binding.installId && currentInstallId !== binding.installId) throw chatError(409, 'install_changed', 'Hermes 安装标识已变化');
    }
    return connection;
  };
  const gatewayFor = async connection => gatewayFactory({ connection, token: await readServeToken(connection), profile: connection.profile, fetchImpl });
  const writeSse = (res, event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (process.env.SIYUAN_BRIDGE_DIAGNOSTICS === '1' && req.url !== '/health') console.log(JSON.stringify({ event:'request_headers', ...requestHeaderProfile(req.headers) }));
    try {
      if (req.url === '/health' && req.method === 'GET') { json(res, 200, { ok: true, service: 'siyuan-ai-collab-bridge' }, origin, origins); return; }
      if (req.method === 'OPTIONS') { const a = authorize(req, capability, origins); if (!a.ok && a.code === 'origin_denied') { json(res, 403, { error: { code: a.code, message: 'Origin is not allowed' } }, origin, origins); return; } res.writeHead(204, corsHeaders(origin, origins)); res.end(); return; }
      const a = authorize(req, capability, origins); if (!a.ok) { json(res, a.status, { error: { code: a.code, message: a.code === 'origin_denied' ? 'Origin is not allowed' : 'Bridge capability required' } }, origin, origins); return; }
      if (await ekkoRoutes(req, res, { origin, origins, authorized: true })) return;
      const u = new URL(req.url, 'http://bridge'); const p = u.pathname; const documentRootId = String(req.headers['x-siyuan-document-root'] || '');
      if (p === '/connections' && req.method === 'GET') {
        const data = await Promise.all(connections.connections.map(async connection => {
          const status = connection.kind === 'serve' ? await probeConnection(connection)
            : connection.kind === 'studio' ? await probeStudio(studioBase, { fetchImpl, timeoutMs: probeTimeoutMs, tokenProvider: tokenProvider || (() => studioToken ?? loadStudioToken()) })
            : connection.kind === 'legacy-api' ? await probeLegacy(hermesBase, { fetchImpl, timeoutMs: probeTimeoutMs, tokenProvider: () => process.env.API_SERVER_KEY || '' })
            : { state: 'incompatible' };
          return { id: connection.id, kind: connection.kind, displayName: connection.displayName || (connection.kind === 'serve' ? 'Hermes Serve' : connection.kind === 'studio' ? 'Hermes Studio' : 'Hermes 旧 API'), state: status.state, profile: connection.profile, installId: status.installId || null, ...(connection.kind === 'studio' && status.state === 'ready' && status.readWarning === 'studio_sessions_unresolved' ? { readWarning: status.readWarning } : {}) };
        }));
        json(res, 200, { data, meta: bridgeMetadata() }, origin, origins); return;
      }
      if (!documentRootId) { json(res, 403, { error: { code: 'document_scope_required', message: 'Document scope required' } }, origin, origins); return; }
      if (!/^\d{14}-[a-z0-9]{7}$/.test(documentRootId)) { json(res, 403, { error: { code: 'invalid_document_root', message: 'Invalid document root' } }, origin, origins); return; }
      const forward = async (path, init = {}) => {
        const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
                const apiKey = process.env.API_SERVER_KEY || '';
                if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        return fetchImpl(`${hermesBase}${path}`, { ...init, headers });
      };
      const studioForward = async (path, init = {}) => {
        const send = async (token) => { const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) }; if (token) headers.Authorization = `Bearer ${token}`; return fetchImpl(`${studioBase}${path}`, { ...init, headers }); };
        const readToken = tokenProvider || (() => studioToken ?? loadStudioToken());
        let response = await send(await readToken());
        if (response.status === 401) response = await send(await readToken());
        return response;
      };
      const finalizePendingStudioSession = async (id) => {
        const binding = findBinding(await readBindings(bindingsFile), documentRootId, id);
        if (!binding?.pending) return;
        const title = String(binding.title || '思源对话').slice(0, 200);
        const renamed = await studioForward(`/api/studio/sessions/${encodeURIComponent(id)}/rename`, { method:'POST', body:JSON.stringify({ title }) });
        if (!renamed.ok) throw new Error(`Studio rename failed (${renamed.status})`);
        await mutateLegacyBindings(bindingsFile, current => {
          const latest = findBinding(current, documentRootId, id);
          return latest?.pending ? { ...current, [`${documentRootId}:${id}`]: { ...latest, pending:false, updatedAt:new Date().toISOString() } } : undefined;
        });
      };
      const executeStudio = async ({ owner, identity, input, instructions, streaming, finalize, update }) => {
        const lease = await runs.begin(owner, identity);
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        req.on('aborted', abort); res.on('close', abort);
        let live = true, accepted = false;
        let writes = Promise.resolve(), writeError, completionEvent, failureEvent, failed = false, text = '';
        if (streaming) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...corsHeaders(origin, origins) });
        try {
          const result = await studioRun({ studioBase, token: studioToken, tokenProvider: tokenProvider || (() => studioToken ?? loadStudioToken()),
            payload: buildRunPayload({ sessionId: identity.storedSessionId, input, instructions }), signal: controller.signal,
            canAbort: () => live && accepted,
            onEvent: (event, data) => {
              if (!live) return;
              if (event === 'run.completed') { live = false; completionEvent = data ?? {}; }
              else if (event === 'run.failed') { live = false; failed = true; failureEvent = data ?? {}; }
              else if (event === 'run.started') {
                writes = writes.then(async () => { if (await runs.transition(lease, 'streaming')) { accepted = live && !controller.signal.aborted; if (streaming) writeSse(res, event, { ...(data ?? {}), runId: lease.attemptId }); } }).catch(error => { writeError = error; controller.abort(); });
              } else {
                if (event === 'message.delta') text += String(data?.delta ?? data?.content ?? '');
                if (streaming) writeSse(res, event, data ?? {});
              }
            } });
          live = false;
          await writes;
          if (writeError) throw writeError;
          if (controller.signal.aborted || failed) throw new Error('Studio run unresolved');
          await finalize();
          await update?.('ready');
          await runs.transition(lease, 'completed', terminalReceipt('studio', 'completed'));
          if (streaming) writeSse(res, 'run.completed', completionEvent ?? { content: String(result?.content ?? '') });
          else json(res, 200, { session_id: identity.storedSessionId, message: { role: 'assistant', content: text || String(result?.content ?? result?.message?.content ?? '') } }, origin, origins);
        } catch {
          live = false;
          await writes;
          const phase = failed && !controller.signal.aborted && !writeError ? 'failed' : 'unknown';
          await update?.(phase === 'failed' ? 'ready' : 'unknown');
          await runs.transition(lease, phase, phase === 'failed' ? terminalReceipt('studio', 'failed') : undefined);
          if (streaming) writeSse(res, phase === 'failed' ? 'run.failed' : 'run.unknown', owner.kind === 'v2' ? { chatId: owner.chatId } : phase === 'failed' ? failureEvent : {});
          else throw chatError(409, 'session_result_unknown', '上次运行结果待核对');
        } finally {
          live = false;
          runs.release(lease); req.off('aborted', abort); res.off('close', abort);
          if (streaming && !res.writableEnded) res.end();
        }
      };
      const studioSessions = async () => {
        const indexResponse = await studioForward('/api/studio/sessions');
        const indexBody = await indexResponse.json().catch(() => ({}));
        if (!indexResponse.ok) throw Object.assign(new Error(`Studio session index failed (${indexResponse.status})`), { status:indexResponse.status, body:indexBody });
        const indexSessions = Array.isArray(indexBody?.sessions) ? indexBody.sessions : [];
        const indexProfiles = new Map(indexSessions.filter(row => row && typeof row.id === 'string').map(row => [row.id, row.profile]));
        let unresolved = false;
        const canonicalSessions = await fetchStudioSessionsPaginated({ fetchPage: async (offset, limit) => {
          const response = await studioForward(`/api/studio/sessions/hermes?offset=${offset}&limit=${limit}`);
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw Object.assign(new Error(`Studio sessions failed (${response.status})`), { status: response.status, body });
          // Observe every page before pagination deduplicates IDs. A duplicate
          // must not hide missing ownership evidence from the list notice.
          if (Array.isArray(body?.sessions)) unresolved ||= body.sessions.some(row => isUnresolvedStudioSession(row, indexProfiles));
          return body;
        }});
        const merged = new Map();
        for (const session of [...indexSessions, ...canonicalSessions]) {
          if (session?.id && !merged.has(session.id)) merged.set(session.id, session);
        }
        return { data: normalizeStudioSessions([...merged.values()]), ...(unresolved ? { readWarning: 'studio_sessions_unresolved' } : {}) };
      };
      const connectionSessions = p.match(/^\/connections\/([^/]+)\/sessions$/);
      if (connectionSessions && req.method === 'GET') {
        const connection = connectionById(decodeURIComponent(connectionSessions[1]));
        if (!connection) throw chatError(404, 'connection_not_found', '连接不存在');
        if (connection.kind === 'studio') { json(res, 200, await studioSessions(), origin, origins); return; }
        if (connection.kind === 'serve') {
          await serveIdentity(connection);
          const gateway = await gatewayFor(connection);
          try { const result = await gateway.list(); json(res, 200, { data: result?.sessions || [] }, origin, origins); }
          finally { gateway.close?.(); }
          return;
        }
        const response = await forward('/api/sessions?source=api_server&limit=200');
        if (!response.ok) throw chatError(503, 'legacy_sessions_failed', '旧 API 会话读取失败');
        const body = await response.json();
        json(res, 200, { data: filterOwnedSessions(body?.data, documentRootId) }, origin, origins); return;
      }
      if (p === '/chats' && req.method === 'POST') {
        const body = await readBody(req);
        const chatId = typeof body.chat_id === 'string' ? body.chat_id : '';
        const connection = connectionById(body.connection_id);
        const title = String(body.title || '新对话');
        if (!validChatId(chatId) || !connection || !validateDocumentTitle(title)) throw chatError(400, 'invalid_chat', 'Chat 参数无效');
        if (chatId.startsWith('siyuan:') && !chatId.startsWith(`siyuan:${documentRootId}:`)) throw chatError(400, 'invalid_chat', '旧 Chat 标识与文档不符');
        if (connection.kind === 'legacy-api') throw chatError(400, 'legacy_create_unsupported', '旧 API 连接不支持新建 Chat');
        const installId = connection.kind === 'serve' ? await serveIdentity(connection) : null;
        let selected;
        await mutateChatBindings(bindingsV2File, current => {
          const previous = current[chatId];
          if (previous) {
            if (previous.connectionId !== connection.id || previous.documentRootId !== documentRootId || previous.profile !== connection.profile || previous.title !== title) throw chatError(409, 'chat_conflict', 'Chat 标识已用于其他绑定');
            if (previous.installId && installId !== previous.installId) throw chatError(409, 'install_changed', 'Hermes 安装标识已变化');
            selected = previous;
            return undefined;
          }
          selected = { chatId, connectionId: connection.id, kind: connection.kind, profile: connection.profile, documentRootId, title, state: 'pending', storedSessionId: connection.kind === 'studio' ? `siyuan:${documentRootId}:${randomUUID()}` : null, installId, anchor: null };
          return { ...current, [chatId]: selected };
        });
        if (connection.kind === 'studio') {
          const id = selected.storedSessionId;
          const key = `${documentRootId}:${id}`;
          await mutateLegacyBindings(bindingsFile, old => {
            assertStudioClaim(old, id, documentRootId);
            return old[key] ? undefined : { ...old, [key]: { id, title, documentRootId, updatedAt: new Date().toISOString(), source: 'studio', profile: connection.profile, pending: true } };
          });
        }
        json(res, 200, { chat: publicChat(selected) }, origin, origins); return;
      }
      if (p === '/chats/bind' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.confirm !== true) throw chatError(400, 'selection_required', '需要用户明确确认关联');
        const chatId = typeof body.chat_id === 'string' ? body.chat_id : '';
        const sessionId = typeof body.stored_session_id === 'string' ? body.stored_session_id : '';
        const connection = connectionById(body.connection_id);
        if (!validChatId(chatId) || !sessionId || !connection) throw chatError(400, 'invalid_binding', '关联参数无效');
        if (chatId.startsWith('siyuan:') && !chatId.startsWith(`siyuan:${documentRootId}:`)) throw chatError(400, 'invalid_binding', '旧 Chat 标识与文档不符');
        const existingV2 = await readChatBindings(bindingsV2File);
        if (existingV2[chatId] && (existingV2[chatId].connectionId !== connection.id || existingV2[chatId].storedSessionId !== sessionId || existingV2[chatId].documentRootId !== documentRootId || existingV2[chatId].kind !== connection.kind || existingV2[chatId].profile !== connection.profile)) throw chatError(409, 'chat_conflict', 'Chat 标识已绑定');
        if (connection.kind === 'studio') assertStudioClaim(await readBindings(bindingsFile), sessionId, documentRootId, connection.profile);
        let title = '';
        let installId = null;
        let anchor = null;
        if (connection.kind === 'serve') {
          installId = await serveIdentity(connection);
          const gateway = await gatewayFor(connection);
          try {
            const listed = await gateway.list();
            const candidate = listed?.sessions?.find(item => item.id === sessionId);
            if (!candidate) throw chatError(404, 'session_not_found', 'Hermes 会话不存在');
            title = String(candidate.title || '已关联对话');
            const history = await gateway.history(sessionId);
            const last = history?.messages?.at(-1);
            if (last && messageId(last)) anchor = anchorOf(last);
          } finally { gateway.close?.(); }
        } else if (connection.kind === 'studio') {
          const candidate = (await studioSessions()).data.find(item => item.id === sessionId);
          if (!candidate) throw chatError(404, 'session_not_found', 'Studio 会话不存在');
          title = candidate.title;
        } else {
          const response = await forward(`/api/sessions/${encodeURIComponent(sessionId)}`);
          const candidate = await response.json();
          if (!response.ok || !validateOwnedSession(candidate?.session || candidate, documentRootId)) throw chatError(403, 'session_scope_denied', '旧 API 会话无法验证归属');
          title = String((candidate.session || candidate).title || '已关联对话');
        }
        let binding = { chatId, connectionId: connection.id, kind: connection.kind, profile: connection.profile, documentRootId, title, state: 'ready', storedSessionId: sessionId, installId, anchor };
        await mutateChatBindings(bindingsV2File, current => {
          const previous = current[chatId];
          if (previous) {
            if (!sameBindingIdentity(previous, binding)) throw chatError(409, 'chat_conflict', 'Chat 标识已绑定');
            binding = previous;
            return undefined;
          }
          assertV2Claim(current, binding);
          return { ...current, [chatId]: binding };
        });
        if (connection.kind === 'studio') await mutateLegacyBindings(bindingsFile, old => {
          assertStudioClaim(old, sessionId, documentRootId, connection.profile);
          const key = `${documentRootId}:${sessionId}`;
          return old[key] ? undefined : { ...old, [key]: { id: sessionId, title, documentRootId, updatedAt: new Date().toISOString(), source: 'studio', profile: connection.profile } };
        });
        json(res, 200, { chat: publicChat(binding) }, origin, origins); return;
      }
      if (p === '/chats' && req.method === 'GET') {
        const current = await readChatBindings(bindingsV2File);
        const filters = new URL(req.url, 'http://bridge').searchParams.getAll('connection_id');
        if (filters.length > 1 || filters.length && !/^[A-Za-z0-9_-]{1,160}$/.test(filters[0])) throw chatError(400, 'invalid_binding', '连接筛选参数无效');
        if (filters.length && !connectionById(filters[0])) throw chatError(404, 'connection_not_found', '连接不存在');
        const rows = Object.values(current).filter(binding => binding.documentRootId === documentRootId && (!filters.length || binding.connectionId === filters[0]));
        // Shared recovery needs both Studio projections. A failed second-file
        // transaction must not turn its surviving V2 row into ready evidence.
        const studioProjection = filters.length && rows.some(binding => binding.kind === 'studio') ? await readBindings(bindingsFile) : null;
        for (const binding of rows) {
          await verifyConnection(binding);
          if (studioProjection && binding.kind === 'studio') {
            if (!studioProjection[`${binding.documentRootId}:${binding.storedSessionId}`]) throw chatError(409, 'chat_conflict', '原 Studio 关联尚未核实');
            assertStudioClaim(studioProjection, binding.storedSessionId, binding.documentRootId, binding.profile);
          }
        }
        json(res, 200, { data: rows.map(publicChat) }, origin, origins); return;
      }
      if (p === '/legacy-bindings' && req.method === 'GET') {
        const old = await readBindings(bindingsFile);
        const data = Object.values(old).filter(binding => binding?.documentRootId === documentRootId && binding?.profile === 'default' && binding?.source === 'studio' && typeof binding.id === 'string').map(binding => ({ chatId: binding.id, connectionId: 'studio-default', adapter: 'studio', profile: 'default', storedSessionId: binding.id, documentRootId: binding.documentRootId, installId: null }));
        json(res, 200, { data }, origin, origins); return;
      }
      const snapshotMatch = p.match(/^\/chats\/([^/]+)\/messages\/snapshot$/);
      if (snapshotMatch) {
        if (req.method !== 'GET') { json(res, 405, { error: { code: 'method_not_allowed', message: 'GET required' } }, origin, origins); return; }
        const chatId = decodeURIComponent(snapshotMatch[1]);
        const snapshot = await withSnapshotDeadline(async signal => {
          // Deliberately bypass liveChat: its recovery of an orphaned creating
          // state writes the binding. This path must not mutate any state.
          const binding = (await readChatBindings(bindingsV2File))[chatId];
          assertSnapshotActive(signal);
          if (!binding) throw chatError(404, 'chat_not_found', 'Chat 不存在');
          assertChatScope(binding, documentRootId);
          if (!['serve', 'studio'].includes(binding.kind)) throw snapshotError('history_snapshot_unsupported');
          if (!binding.storedSessionId) throw snapshotError();
          const verifySnapshotConnection = async () => {
            const current = connectionById(binding.connectionId);
            if (!current || current.profile !== binding.profile || current.kind !== binding.kind) throw chatError(409, 'connection_changed', '连接配置已变化');
            if (binding.kind === 'serve') {
              if (typeof binding.installId !== 'string' || !binding.installId) throw snapshotError();
              const response = await fetchImpl(new URL('/api/status', assertLoopbackServeUrl(current.baseUrl)), { method: 'GET', redirect: 'error', signal });
              assertSnapshotActive(signal);
              if (!response.ok || response.redirected || response.status >= 300) throw snapshotError();
              const status = await response.json();
              assertSnapshotActive(signal);
              if (status?.install_id !== binding.installId) throw chatError(409, 'install_changed', 'Hermes 安装标识已变化');
            }
            return current;
          };
          const connection = await verifySnapshotConnection();
          assertSnapshotActive(signal);
          // One approved credential is held for this bounded operation; a 401
          // never causes a second authorization source or an automatic retry.
          const snapshotStudioToken = binding.kind === 'studio' ? await (tokenProvider || (() => studioToken ?? loadStudioToken()))() : undefined;
          assertSnapshotActive(signal);
          const source = Object.fromEntries(['chatId', 'documentRootId', 'connectionId', 'kind', 'profile', 'storedSessionId', 'installId'].map(key => [key, binding[key]]));
          const readComplete = async () => {
            assertSnapshotActive(signal);
            if (binding.kind === 'studio') {
              // This read does not rotate/retry authorization or call any of
              // the mutable compatibility paths.
              const result = await fetchStudioMessagesSnapshot({ sessionId: binding.storedSessionId, profile: binding.profile, signal,
                fetchPage: async (offset, limit) => {
                  assertSnapshotActive(signal);
                  const query = new URLSearchParams({ profile: binding.profile, offset: String(offset), limit: String(limit) });
                  const response = await fetchImpl(`${studioBase}/api/studio/sessions/conversations/${encodeURIComponent(binding.storedSessionId)}/messages/paginated?${query}`, {
                    method: 'GET', redirect: 'error', signal, headers: snapshotStudioToken ? { Authorization: `Bearer ${snapshotStudioToken}` } : {},
                  });
                  assertSnapshotActive(signal);
                  if (!response.ok || response.redirected || response.status >= 300) throw snapshotError();
                  return response.json();
                },
              });
              return { records: result.records, messages: snapshotDisplayMessages(result.records) };
            }
            const gateway = await gatewayFor(connection);
            const close = () => gateway.close?.();
            if (signal.aborted) { close(); assertSnapshotActive(signal); }
            signal.addEventListener('abort', close, { once: true });
            try {
              const history = await gateway.history(binding.storedSessionId, { captureSnapshotRecords: true });
              assertSnapshotActive(signal);
              if (!Array.isArray(history?.snapshotRecords) || !Array.isArray(history.messages) || history.count !== history.messages.length) throw snapshotError();
              checkAnchor(binding, history.messages);
              return { records: history.snapshotRecords, messages: snapshotDisplayMessages(history.messages, { idKey: 'row_id', contentKey: 'text' }) };
            } catch (error) {
              if (error?.code === 'history_anchor_mismatch' || error?.code === 'history_snapshot_timeout') throw error;
              throw snapshotError();
            } finally { signal.removeEventListener('abort', close); close(); }
          };
          return captureHistorySnapshot({ source, readComplete, signal, verifyUnchanged: async () => {
            await verifySnapshotConnection();
            assertSnapshotActive(signal);
            const current = (await readChatBindings(bindingsV2File))[chatId];
            if (!current || !sameBindingIdentity(binding, current) || JSON.stringify(binding.anchor) !== JSON.stringify(current.anchor)) throw snapshotError('history_snapshot_changed');
          } });
        }, snapshotTimeoutMs);
        json(res, 200, { snapshot }, origin, origins); return;
      }
      const chatMatch = p.match(/^\/chats\/([^/]+)(\/messages|\/chat\/stream|\/status|\/stop)?$/);
      if (chatMatch) {
        const chatId = decodeURIComponent(chatMatch[1]);
        const binding = await liveChat(chatId);
        assertChatScope(binding, documentRootId);
        const connection = await verifyConnection(binding);
        if (chatMatch[2] === '/status' && req.method === 'GET') { const run = binding.kind === 'legacy-api' ? { state: 'idle' } : await runs.inspect(runIdentity(binding), runOwner(binding)); json(res, 200, { chatId, state: binding.state, lastRunState: binding.lastRunState || null, ...(run.state === 'idle' ? {} : { run }) }, origin, origins); return; }
        if (chatMatch[2] === '/stop' && req.method === 'POST') {
          const body = await readBody(req);
          const ticket = sessionRuntime.get(chatId);
          const run = binding.kind === 'legacy-api' ? { state: 'idle' } : await runs.inspect(runIdentity(binding), runOwner(binding));
          if (!ticket || body.runId !== ticket.runId || run.state !== 'streaming' || !run.isOwner || binding.kind !== 'serve') {
            json(res, 200, { state: activeChats.has(chatId) || run.state !== 'idle' ? 'unknown' : 'not_running' }, origin, origins); return;
          }
          const gateway = await gatewayFor(connection);
          try {
            if (sessionRuntime.get(chatId) !== ticket) { json(res, 200, { state: 'unknown' }, origin, origins); return; }
            sessionRuntime.delete(chatId);
            const result = await gateway.interrupt(ticket.runtimeSessionId);
            json(res, 200, { state: result?.status === 'interrupted' ? 'interrupted' : 'unknown' }, origin, origins);
          } finally { gateway.close?.(); }
          return;
        }
        if (binding.kind === 'studio' && chatMatch[2] === '/messages' && req.method === 'GET') {
          const id = binding.storedSessionId;
          const result = await fetchStudioMessagesPaginated({ sessionId: id, fetchPage: async (offset, limit) => {
            const response = await studioForward(`/api/studio/sessions/conversations/${encodeURIComponent(id)}/messages/paginated?offset=${offset}&limit=${limit}`);
            if (!response.ok) throw chatError(response.status, 'studio_history_failed', 'Studio 历史读取失败');
            return response.json();
          } });
          json(res, 200, { ...normalizeStudioMessages({ messages: result.messages }, id), total: result.total, offset: result.offset, limit: result.limit, hasMore: false }, origin, origins); return;
        }
        if (binding.kind === 'studio' && chatMatch[2] === '/chat/stream' && req.method === 'POST') {
          const body = await readBody(req);
          const input = typeof body.message === 'string' ? body.message : '';
          if (!input.trim()) throw chatError(400, 'empty_message', '消息不能为空');
          if (binding.state === 'unknown') throw chatError(409, 'chat_result_unknown', '上一轮结果未核实');
          await executeStudio({ owner: runOwner(binding), identity: runIdentity(binding), input, instructions: String(body.system_message || ''), streaming: true,
            finalize: () => finalizePendingStudioSession(binding.storedSessionId), update: state => saveChat(chatId, { state }) });
          return;
        }
        if (binding.kind !== 'serve' && chatMatch[2]) {
          const suffix = chatMatch[2];
          const oldPath = `/sessions/${encodeURIComponent(binding.storedSessionId)}${suffix}`;
          res.writeHead(307, { Location: oldPath, ...corsHeaders(origin, origins) }); res.end(); return;
        }
        if (!chatMatch[2] && req.method === 'GET') { json(res, 200, { chat: publicChat(binding) }, origin, origins); return; }
        if (chatMatch[2] === '/messages' && req.method === 'GET') {
          if (!binding.storedSessionId) { json(res, 200, { data: [] }, origin, origins); return; }
          const gateway = await gatewayFor(connection);
          try {
            const history = await gateway.history(binding.storedSessionId);
            const messages = Array.isArray(history?.messages) ? history.messages : [];
            checkAnchor(binding, messages);
            const last = messages.at(-1);
            if (last && messageId(last)) await saveChat(chatId, { anchor: anchorOf(last) });
            json(res, 200, { data: messages.map(message => ({ id: messageId(message), role: message.role, content: String(message.text ?? ''), ...(message.timestamp == null ? {} : { timestamp: message.timestamp }) })) }, origin, origins);
          } finally { gateway.close?.(); }
          return;
        }
        if (chatMatch[2] === '/chat/stream' && req.method === 'POST') {
          const body = await readBody(req);
          const message = typeof body.message === 'string' ? body.message : '';
          const systemMessage = typeof body.system_message === 'string' ? body.system_message : '';
          if (!message.trim()) throw chatError(400, 'empty_message', '消息不能为空');
          if (binding.state === 'unknown' || binding.state === 'creating' || (binding.state === 'pending' && binding.storedSessionId)) throw chatError(409, 'chat_result_unknown', '上一轮结果未核实');
          if (activeChats.has(chatId)) throw chatError(409, 'chat_busy', 'Chat 正在处理');
          activeChats.add(chatId);
          const gateway = await gatewayFor(connection);
          try {
            if (binding.storedSessionId) {
              const history = await gateway.history(binding.storedSessionId);
              checkAnchor(binding, Array.isArray(history?.messages) ? history.messages : []);
            }
            const lease = await runs.begin(runOwner(binding), runIdentity(binding));
            try {
              if (!binding.storedSessionId) await saveChat(chatId, { state: 'creating' });
              let runtimeSessionId, ticketClosed = false;
              const controller = new AbortController();
              const retireTicket = () => {
                ticketClosed = true;
                if (sessionRuntime.get(chatId)?.runId === lease.attemptId) sessionRuntime.delete(chatId);
              };
              const abort = () => { retireTicket(); controller.abort(); };
              req.on('aborted', abort); res.on('close', abort);
              res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...corsHeaders(origin, origins) });
              try {
                if (!binding.storedSessionId) {
                  const created = await gateway.create(binding.title);
                  runtimeSessionId = created.runtimeSessionId;
                  await runs.attachSession(lease, { ...runIdentity(binding), storedSessionId: created.storedSessionId });
                  await saveChat(chatId, { state: 'pending' });
                } else runtimeSessionId = await gateway.resume(binding.storedSessionId);
                // Hermes prompt.submit accepts one text field, so preserve the frozen context in that field.
                const submitText = systemMessage ? `${systemMessage}\n\n【用户问题】\n${message}` : message;
                let acceptedUserRowId = null;
                let acceptance = Promise.resolve(), acceptanceError;
                const result = await gateway.submit(runtimeSessionId, submitText, { signal: controller.signal, onEvent: event => {
                  if (event?.type === 'message.complete') retireTicket();
                  if (event?.type === 'message.delta') {
                    const delta = typeof event.payload?.delta === 'string' ? event.payload.delta : event.payload?.text;
                    if (typeof delta === 'string') writeSse(res, 'message.delta', { delta });
                  }
                }, onAccepted: accepted => {
                  if (accepted?.status === 'streaming' && typeof accepted.userRowId === 'number') {
                    acceptedUserRowId = accepted.userRowId;
                    acceptance = acceptance.then(async () => {
                      if (await runs.transition(lease, 'streaming')) {
                        if (!ticketClosed && !controller.signal.aborted) sessionRuntime.set(chatId, { runtimeSessionId, runId: lease.attemptId });
                        writeSse(res, 'run.started', { chatId, userRowId: accepted.userRowId, runId: lease.attemptId });
                      }
                    }).catch(error => { acceptanceError = error; controller.abort(); });
                  }
                } });
                // A returned outcome ends the live stop window before any history read or disk write.
                retireTicket();
                await acceptance;
                if (acceptanceError) throw acceptanceError;
                const userRowId = typeof result.userRowId === 'number' ? result.userRowId : acceptedUserRowId;
                if (result.state === 'queued') {
                  await saveChat(chatId, { state: 'pending', lastRunState: 'queued' });
                  await runs.transition(lease, 'queued');
                  writeSse(res, 'run.queued', { chatId });
                } else if (userRowId !== null) {
                  let persisted = result.state !== 'unknown';
                  if (!persisted) {
                    try {
                      const history = await gateway.history((await liveChat(chatId)).storedSessionId);
                      const messages = Array.isArray(history?.messages) ? history.messages : [];
                      const lastUser = messages.filter(row => row?.role === 'user').at(-1);
                      persisted = Number(lastUser?.row_id ?? lastUser?.id) === userRowId && String(lastUser?.text ?? lastUser?.content ?? '') === submitText;
                    } catch { persisted = false; }
                  }
                  await saveChat(chatId, { state: persisted ? 'ready' : 'unknown', lastRunState: result.state });
                  const phase = controller.signal.aborted ? 'unknown' : result.state === 'complete' ? 'completed' : ['failed', 'interrupted'].includes(result.state) ? 'failed' : 'unknown';
                  await runs.transition(lease, phase, phase === 'unknown' ? undefined : terminalReceipt('serve', phase));
                  writeSse(res, phase === 'completed' ? 'run.completed' : phase === 'unknown' ? 'run.unknown' : 'run.failed', { chatId, text: result.text, userRowId });
                } else {
                  await saveChat(chatId, { state: 'unknown', lastRunState: result.state });
                  await runs.transition(lease, 'unknown');
                  writeSse(res, result.state === 'failed' ? 'run.failed' : 'run.unknown', { chatId });
                }
              } catch {
                retireTicket();
                await runs.transition(lease, 'unknown');
                await saveChat(chatId, { state: 'unknown' });
                writeSse(res, 'run.unknown', { chatId });
              } finally { sessionRuntime.delete(chatId); req.off('aborted', abort); res.off('close', abort); if (!res.writableEnded) res.end(); }
            } finally { runs.release(lease); }
          } finally { gateway.close?.(); activeChats.delete(chatId); }
          return;
        }
      }
      const bindings = await readBindings(bindingsFile);
      if (p === '/studio/sessions' && req.method === 'GET') { json(res, 200, await studioSessions(), origin, origins); return; }
      if (p === '/studio/bind' && req.method === 'POST') {
        const b = await readBody(req); const id = typeof b.session_id === 'string' ? b.session_id : '';
        const session = (await studioSessions()).data.find(s => s.id === id);
        if (!session) { json(res, 404, { error: { code: 'studio_session_not_found', message: 'Studio session not found' } }, origin, origins); return; }
        const key = `${documentRootId}:${session.id}`; const binding = { ...safeBinding({ id: session.id, title: session.title, documentRootId }), source:'studio', profile:'default' };
        await mutateLegacyBindings(bindingsFile, current => ({ ...current, [key]: current[key] ? { ...binding, ...current[key] } : binding })); json(res, 200, { binding }, origin, origins); return;
      }
      if (p === '/sessions' && req.method === 'GET') {
        const r = await forward('/api/sessions?source=api_server&limit=200'); const data = await r.json();
        const legacy = r.ok && data && Array.isArray(data.data) ? filterOwnedSessions(data.data, documentRootId) : [];
        const local = Object.values(bindings).filter(b => b && b.documentRootId === documentRootId && b.profile === 'default' && typeof b.id === 'string').map(b => ({ id:b.id, title:String(b.title || ''), source:'studio', profile:'default', message_count:0, preview:'', ...(b.pending ? {pending:true} : {}) }));
        const merged = new Map([...legacy, ...local].map(s => [s.id, s]));
        json(res, r.status, r.ok ? { ...data, data:[...merged.values()] } : data, origin, origins); return;
      }
      if (p === '/sessions' && req.method === 'POST') { const b = await readBody(req); const title = String(b.title || '新对话'); if (!validateDocumentTitle(title)) { json(res, 400, { error: { code: 'invalid_document_title', message: 'Invalid document title' } }, origin, origins); return; } const requested = typeof b.session_id === 'string' ? b.session_id : ''; const id = requested.startsWith(`siyuan:${documentRootId}:`) ? requested : `siyuan:${documentRootId}:${crypto.randomUUID()}`; let selected; await mutateLegacyBindings(bindingsFile, current => { selected = current[`${documentRootId}:${id}`] || { id, title, documentRootId, updatedAt:new Date().toISOString(), source:'studio', profile:'default', pending:true }; return { ...current, [`${documentRootId}:${id}`]: selected }; }); json(res, 200, { session:{ id, title:selected.title, source:'studio', profile:'default', message_count:0, preview:'' } }, origin, origins); return; }
      const m = p.match(/^\/sessions\/([^/]+)(\/messages|\/chat|\/chat\/stream)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const upstreamId = pathId(id);
        const bound = findBinding(bindings, documentRootId, id);
        if (bound?.id === id && bound.documentRootId === documentRootId && bound.profile === 'default') {
          if (m[2] === '/messages' && req.method === 'GET') { const result = await fetchStudioMessagesPaginated({ sessionId:id, fetchPage: async (offset, limit) => { const r = await studioForward(`/api/studio/sessions/conversations/${encodeURIComponent(id)}/messages/paginated?offset=${offset}&limit=${limit}`); const body = await r.json(); if (!r.ok) throw Object.assign(new Error(`Studio messages failed (${r.status})`), { status:r.status, body }); return body; } }); const normalized = normalizeStudioMessages({ messages:result.messages }, id); json(res, 200, { ...normalized, total:result.total, offset:result.offset, limit:result.limit, hasMore:false }, origin, origins); return; }
          if ((m[2] === '/chat' || m[2] === '/chat/stream') && req.method === 'POST') {
            const body = await readBody(req); const input = String(body.message || '');
            if (!input.trim()) throw chatError(400, 'empty_message', '消息不能为空');
            await executeStudio({ owner: { kind: 'legacy-studio', sessionId: id, documentRootId }, identity: legacyRunIdentity(bound), input,
              instructions: String(body.system_message || ''), streaming: m[2] === '/chat/stream', finalize: () => finalizePendingStudioSession(id) });
            return;
          }
        }
        const sessionResponse = await forward(`/api/sessions/${upstreamId}`); const sessionData = await sessionResponse.json(); const session = sessionData?.session || sessionData;
        if (!sessionResponse.ok || !validateOwnedSession(session, documentRootId)) { json(res, 403, { error: { code: 'session_scope_denied', message: 'Session is outside document scope' } }, origin, origins); return; }
        if (m[2] === '/messages' && req.method === 'GET') { const bound = findBinding(bindings, documentRootId, id); if (bound?.profile === 'default') { const r = await studioForward(`/api/studio/sessions/conversations/${encodeURIComponent(id)}/messages/paginated?offset=0&limit=200`); json(res, r.status, normalizeStudioMessages(await r.json(), id), origin, origins); return; } const r = await forward(`/api/sessions/${upstreamId}/messages`); json(res, r.status, await r.json(), origin, origins); return; }
        if (m[2] === '/chat' && req.method === 'POST') { const b = await readBody(req); const r = await forward(`/api/sessions/${upstreamId}/chat`, { method: 'POST', body: JSON.stringify({ message: String(b.message || ''), system_message: b.system_message }) }); json(res, r.status, await r.json(), origin, origins); return; }
        if (m[2] === '/chat/stream' && req.method === 'POST') {
          const b = await readBody(req); const upstreamAbort = new AbortController();
          const close = () => { if (!res.writableEnded) upstreamAbort.abort(); };
          req.on('aborted', close); res.on('close', close);
          const r = await forward(`/api/sessions/${upstreamId}/chat/stream`, { method: 'POST', body: JSON.stringify({ message: String(b.message || ''), system_message: b.system_message }), signal: upstreamAbort.signal });
          res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...corsHeaders(origin, origins) });
          if (r.body) for await (const chunk of r.body) { if (res.destroyed) break; res.write(chunk); }
          if (!res.writableEnded) res.end(); return;
        }
      }
      json(res, 404, { error: { code: 'not_found', message: 'Bridge route not found' } }, origin, origins);
    } catch (e) {
      if (!res.headersSent) {
        const newRoute = /^\/(chats|connections|legacy-bindings)(\/|$)/.test(new URL(req.url, 'http://bridge').pathname);
        const safe = newRoute || ['session_busy', 'session_result_unknown', 'session_identity_unknown', 'empty_message'].includes(e?.code) ? safeErrors.get(e?.code) : null;
        json(res, safe ? safe[0] : 500, { error: { code: safe ? e.code : 'bridge_error', message: safe ? safe[1] : newRoute ? 'Bridge request failed' : e?.message || String(e) } }, origin, origins);
      } else res.destroy(e);
    }
  });
  return { server, capability, connections };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { host, port, tokenFile } = loadBridgeEnvironment();
  const { server, capability } = createBridgeServer(); if (typeof capability !== 'string' || capability.length < 64) throw new Error('Bridge 凭证尚未准备；请先运行 node scripts/pair.mjs，然后在插件设置中核对并保存'); server.listen(port, host, () => console.log(JSON.stringify({ service: 'siyuan-ai-collab-bridge', host, port, hermesBase: process.env.HERMES_API_URL || 'http://127.0.0.1:8642', allowedOrigins: DEFAULT_ORIGINS, capability: 'configured' })));
}
