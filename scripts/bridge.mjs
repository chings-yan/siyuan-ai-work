import { createServer } from 'node:http';
import { createEkkoRouteHandler } from './ekko-routes.mjs';
import { bridgeMetadata } from './bridge-metadata.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBridgeConfig, loadBridgeEnvironment } from './bridge-config.mjs';
import { readBindings, normalizeStudioSessions, normalizeStudioMessages, buildRunPayload, validateDocumentTitle, safeBinding, runStudioSocket, fetchStudioMessagesPaginated, fetchStudioSessionsPaginated, isUnresolvedStudioSession } from './studio-client.mjs';
import { connectionRegistry, readServeToken, probeServe, probeStudio, probeLegacy } from './hermes-connections.mjs';
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

export function createBridgeServer({ fetchImpl = fetch, capability = loadCapability(), hermesBase = (process.env.HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/$/, ''), studioBase = (process.env.HERMES_STUDIO_URL || 'http://127.0.0.1:8748').replace(/\/$/, ''), studioToken, tokenProvider, probeTimeoutMs = 5_000, studioRun = runStudioSocket, bindingsFile = resolveBridgeConfig().bindingsFile, bindingsV2File = process.env.SIYUAN_BRIDGE_BINDINGS_V2_FILE || join(dirname(bindingsFile), 'siyuan-ai-collab-bindings-v2.json'), origins = DEFAULT_ORIGINS, ekko = {}, connections = connectionRegistry(), gatewayFactory = ({ connection, token }) => ({ ...createGatewayClient({ baseUrl: connection.baseUrl, token, profile: connection.profile, fetchImpl }), ping: ({ signal } = {}) => pingServe(connection, token, signal) }) } = {}) {
  const ekkoRoutes = createEkkoRouteHandler({ fetchImpl, ...ekko });
  const activeChats = new Set();
  const sessionRuntime = new Map();
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
  }));
  const assertStudioClaim = (old, id, root) => {
    if (Object.values(old).some(binding => binding?.id === id && binding.documentRootId !== root)) throw chatError(409, 'session_claimed', 'Studio 会话已属于其他文档');
  };
  const assertV2Claim = (current, connectionId, sessionId, root, chatId) => {
    if (Object.values(current).some(binding => binding?.connectionId === connectionId && binding.storedSessionId === sessionId && binding.chatId !== chatId)) throw chatError(409, 'session_claimed', '会话已关联其他 Chat');
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
        if (existingV2[chatId] && (existingV2[chatId].connectionId !== connection.id || existingV2[chatId].storedSessionId !== sessionId || existingV2[chatId].documentRootId !== documentRootId)) throw chatError(409, 'chat_conflict', 'Chat 标识已绑定');
        assertV2Claim(existingV2, connection.id, sessionId, documentRootId, chatId);
        if (connection.kind === 'studio') assertStudioClaim(await readBindings(bindingsFile), sessionId, documentRootId);
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
        const binding = { chatId, connectionId: connection.id, kind: connection.kind, profile: connection.profile, documentRootId, title, state: 'ready', storedSessionId: sessionId, installId, anchor };
        await mutateChatBindings(bindingsV2File, current => {
          assertV2Claim(current, connection.id, sessionId, documentRootId, chatId);
          if (current[chatId] && JSON.stringify(current[chatId]) !== JSON.stringify(binding)) throw chatError(409, 'chat_conflict', 'Chat 标识已绑定');
          return { ...current, [chatId]: binding };
        });
        if (connection.kind === 'studio') await mutateLegacyBindings(bindingsFile, old => {
          assertStudioClaim(old, sessionId, documentRootId);
          const key = `${documentRootId}:${sessionId}`;
          return old[key] ? undefined : { ...old, [key]: { id: sessionId, title, documentRootId, updatedAt: new Date().toISOString(), source: 'studio', profile: connection.profile } };
        });
        json(res, 200, { chat: publicChat(binding) }, origin, origins); return;
      }
      if (p === '/chats' && req.method === 'GET') {
        const current = await readChatBindings(bindingsV2File);
        const rows = Object.values(current).filter(binding => binding.documentRootId === documentRootId);
        for (const binding of rows) await verifyConnection(binding);
        json(res, 200, { data: rows.map(publicChat) }, origin, origins); return;
      }
      if (p === '/legacy-bindings' && req.method === 'GET') {
        const old = await readBindings(bindingsFile);
        const data = Object.values(old).filter(binding => binding?.documentRootId === documentRootId && binding?.profile === 'default' && binding?.source === 'studio' && typeof binding.id === 'string').map(binding => ({ chatId: binding.id, connectionId: 'studio-default', adapter: 'studio', profile: 'default', storedSessionId: binding.id, documentRootId: binding.documentRootId, installId: null }));
        json(res, 200, { data }, origin, origins); return;
      }
      const chatMatch = p.match(/^\/chats\/([^/]+)(\/messages|\/chat\/stream|\/status|\/stop)?$/);
      if (chatMatch) {
        const chatId = decodeURIComponent(chatMatch[1]);
        const binding = await liveChat(chatId);
        assertChatScope(binding, documentRootId);
        const connection = await verifyConnection(binding);
        if (chatMatch[2] === '/status' && req.method === 'GET') { json(res, 200, { chatId, state: binding.state, lastRunState: binding.lastRunState || null }, origin, origins); return; }
        if (chatMatch[2] === '/stop' && req.method === 'POST') {
          const runtimeSessionId = sessionRuntime.get(chatId);
          if (!runtimeSessionId) { json(res, 200, { state: activeChats.has(chatId) ? 'unknown' : 'not_running' }, origin, origins); return; }
          if (binding.kind !== 'serve') { json(res, 200, { state: 'not_running' }, origin, origins); return; }
          sessionRuntime.delete(chatId);
          const gateway = await gatewayFor(connection);
          try {
            const result = await gateway.interrupt(runtimeSessionId);
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
          if (activeChats.has(chatId)) throw chatError(409, 'chat_busy', 'Chat 正在处理');
          activeChats.add(chatId);
          const controller = new AbortController();
          const abort = () => controller.abort();
          req.on('aborted', abort); res.on('close', abort);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...corsHeaders(origin, origins) });
          try {
            let completionEvent = null;
            const completed = await studioRun({ studioBase, token: studioToken, tokenProvider: tokenProvider || (() => studioToken ?? loadStudioToken()), payload: buildRunPayload({ sessionId: binding.storedSessionId, input, instructions: String(body.system_message || '') }), signal: controller.signal, onEvent: (event, data) => { if (event === 'run.completed') completionEvent = data ?? {}; else if (event !== 'run.failed') writeSse(res, event, data ?? {}); } });
            const old = await readBindings(bindingsFile);
            const key = `${documentRootId}:${binding.storedSessionId}`;
            if (old[key]?.pending) {
              const renamed = await studioForward(`/api/studio/sessions/${encodeURIComponent(binding.storedSessionId)}/rename`, { method: 'POST', body: JSON.stringify({ title: binding.title }) });
              if (!renamed.ok) throw new Error('Studio rename failed');
              await mutateLegacyBindings(bindingsFile, current => current[key]?.pending ? { ...current, [key]: { ...current[key], pending: false, updatedAt: new Date().toISOString() } } : undefined);
            }
            await saveChat(chatId, { state: 'ready' });
            writeSse(res, 'run.completed', completionEvent ?? { text: String(completed?.content ?? '') });
          } catch { await saveChat(chatId, { state: 'unknown' }); writeSse(res, 'run.unknown', { chatId }); }
          finally { req.off('aborted', abort); res.off('close', abort); activeChats.delete(chatId); if (!res.writableEnded) res.end(); }
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
            if (!binding.storedSessionId) await saveChat(chatId, { state: 'creating' });
            const controller = new AbortController();
            const abort = () => controller.abort();
            req.on('aborted', abort); res.on('close', abort);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...corsHeaders(origin, origins) });
            let runtimeSessionId;
            try {
              if (!binding.storedSessionId) {
                const created = await gateway.create(binding.title);
                runtimeSessionId = created.runtimeSessionId;
                await saveChat(chatId, { storedSessionId: created.storedSessionId, state: 'pending' });
              } else runtimeSessionId = await gateway.resume(binding.storedSessionId);
              // Hermes prompt.submit accepts one text field, so preserve the frozen context in that field.
              const submitText = systemMessage ? `${systemMessage}\n\n【用户问题】\n${message}` : message;
              let acceptedUserRowId = null;
              const result = await gateway.submit(runtimeSessionId, submitText, { signal: controller.signal, onEvent: event => {
                if (event?.type === 'message.complete') sessionRuntime.delete(chatId);
                if (event?.type === 'message.delta') {
                  const delta = typeof event.payload?.delta === 'string' ? event.payload.delta : event.payload?.text;
                  if (typeof delta === 'string') writeSse(res, 'message.delta', { delta });
                }
              }, onAccepted: accepted => {
                if (accepted?.status === 'streaming' && typeof accepted.userRowId === 'number') {
                  acceptedUserRowId = accepted.userRowId;
                  sessionRuntime.set(chatId, runtimeSessionId);
                  writeSse(res, 'run.started', { chatId, userRowId: accepted.userRowId });
                }
              } });
              const userRowId = typeof result.userRowId === 'number' ? result.userRowId : acceptedUserRowId;
              if (result.state === 'queued') {
                await saveChat(chatId, { state: 'pending', lastRunState: 'queued' });
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
                writeSse(res, result.state === 'complete' ? 'run.completed' : result.state === 'unknown' ? 'run.unknown' : 'run.failed', { chatId, text: result.text, userRowId });
              } else {
                await saveChat(chatId, { state: 'unknown', lastRunState: result.state });
                writeSse(res, result.state === 'failed' ? 'run.failed' : 'run.unknown', { chatId });
              }
            } catch {
              await saveChat(chatId, { state: 'unknown' });
              writeSse(res, 'run.unknown', { chatId });
            } finally { sessionRuntime.delete(chatId); req.off('aborted', abort); res.off('close', abort); if (!res.writableEnded) res.end(); }
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
        await mutateLegacyBindings(bindingsFile, current => ({ ...current, [key]: binding })); json(res, 200, { binding }, origin, origins); return;
      }
      if (p === '/sessions' && req.method === 'GET') {
        const r = await forward('/api/sessions?source=api_server&limit=200'); const data = await r.json();
        const legacy = r.ok && data && Array.isArray(data.data) ? filterOwnedSessions(data.data, documentRootId) : [];
        const local = Object.values(bindings).filter(b => b && b.documentRootId === documentRootId && b.profile === 'default' && typeof b.id === 'string').map(b => ({ id:b.id, title:String(b.title || ''), source:'studio', profile:'default', message_count:0, preview:'', ...(b.pending ? {pending:true} : {}) }));
        const merged = new Map([...legacy, ...local].map(s => [s.id, s]));
        json(res, r.status, r.ok ? { ...data, data:[...merged.values()] } : data, origin, origins); return;
      }
      if (p === '/sessions' && req.method === 'POST') { const b = await readBody(req); const title = String(b.title || '新对话'); if (!validateDocumentTitle(title)) { json(res, 400, { error: { code: 'invalid_document_title', message: 'Invalid document title' } }, origin, origins); return; } const requested = typeof b.session_id === 'string' ? b.session_id : ''; const id = requested.startsWith(`siyuan:${documentRootId}:`) ? requested : `siyuan:${documentRootId}:${crypto.randomUUID()}`; await mutateLegacyBindings(bindingsFile, current => ({ ...current, [`${documentRootId}:${id}`]: { id, title, documentRootId, updatedAt:new Date().toISOString(), source:'studio', profile:'default', pending:true } })); json(res, 200, { session:{ id, title, source:'studio', profile:'default', message_count:0, preview:'' } }, origin, origins); return; }
      const m = p.match(/^\/sessions\/([^/]+)(\/messages|\/chat|\/chat\/stream)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const upstreamId = pathId(id);
        const bound = findBinding(bindings, documentRootId, id);
        if (bound?.id === id && bound.documentRootId === documentRootId && bound.profile === 'default') {
          if (m[2] === '/messages' && req.method === 'GET') { const result = await fetchStudioMessagesPaginated({ sessionId:id, fetchPage: async (offset, limit) => { const r = await studioForward(`/api/studio/sessions/conversations/${encodeURIComponent(id)}/messages/paginated?offset=${offset}&limit=${limit}`); const body = await r.json(); if (!r.ok) throw Object.assign(new Error(`Studio messages failed (${r.status})`), { status:r.status, body }); return body; } }); const normalized = normalizeStudioMessages({ messages:result.messages }, id); json(res, 200, { ...normalized, total:result.total, offset:result.offset, limit:result.limit, hasMore:false }, origin, origins); return; }
          if (m[2] === '/chat' && req.method === 'POST') { const b=await readBody(req); const input=String(b.message||''); let text=''; const result=await studioRun({studioBase,token:studioToken,tokenProvider:tokenProvider || (() => studioToken ?? loadStudioToken()),payload:buildRunPayload({sessionId:id,input,instructions:String(b.system_message||'')}),onEvent:(event,data)=>{if(event==='message.delta')text+=String(data?.delta??data?.content??'');}}); await finalizePendingStudioSession(id); text ||= String(result?.content??result?.message?.content??''); json(res,200,{session_id:id,message:{role:'assistant',content:text}},origin,origins); return; }
          if (m[2] === '/chat/stream' && req.method === 'POST') { const b=await readBody(req); const input=String(b.message||''); if(!input.trim()){json(res,400,{error:{code:'empty_message',message:'Message required'}},origin,origins);return;} const controller=new AbortController(); const close=()=>controller.abort(); req.on('aborted',close); res.on('close',close); res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive',...corsHeaders(origin,origins)}); try { await studioRun({studioBase,token:studioToken,tokenProvider:tokenProvider || (() => studioToken ?? loadStudioToken()),payload:buildRunPayload({sessionId:id,input,instructions:String(b.system_message||'')}),signal:controller.signal,onEvent:(event,data)=>{if(!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data??{})}\n\n`);}}); await finalizePendingStudioSession(id); if(!res.writableEnded)res.end(); } catch(e) { if(!res.destroyed){res.write(`event: run.failed\ndata: ${JSON.stringify({error:String(e?.message||e)})}\n\n`);res.end();} } return; }
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
        const safe = newRoute ? safeErrors.get(e?.code) : null;
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
