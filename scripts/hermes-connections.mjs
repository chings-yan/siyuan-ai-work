import { readFile } from 'node:fs/promises';
import { isUnresolvedStudioSession } from './studio-client.mjs';

const PROBE_TIMEOUT_MS = 5_000;

export function assertLoopbackServeUrl(raw) {
  if (typeof raw !== 'string' || !/^http:\/\/127\.0\.0\.1(?::\d{1,5})?\/?$/i.test(raw)) {
    throw new Error('Serve 地址必须是无路径、无认证信息的 HTTP 127.0.0.1 回环地址');
  }
  let url;
  try { url = new URL(raw); } catch { throw new Error('Serve 地址无效'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Serve 地址必须是无路径、无认证信息的 HTTP 127.0.0.1 回环地址');
  }
  return url;
}

export function connectionRegistry(env = process.env) {
  return {
    defaultConnectionId: 'serve-local',
    connections: [
      { id: 'serve-local', kind: 'serve', baseUrl: assertLoopbackServeUrl(env.SIYUAN_HERMES_SERVE_URL || 'http://127.0.0.1:9119').href, profile: env.SIYUAN_HERMES_SERVE_PROFILE || 'default', tokenFile: env.SIYUAN_HERMES_SERVE_TOKEN_FILE || '' },
      { id: 'studio-default', kind: 'studio', profile: 'default' },
      { id: 'legacy-api', kind: 'legacy-api', profile: 'default' },
    ],
  };
}

export async function readServeToken(connection) {
  if (!connection?.tokenFile) return '';
  try { return (await readFile(connection.tokenFile, 'utf8')).trim(); }
  catch { return ''; }
}

function statusOf(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.code);
}

const probeFailure = state => Object.assign(new Error('Connection inspection failed'), { probeState: state });
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validSessions = rows => Array.isArray(rows) && rows.every(row => isRecord(row) && typeof row.id === 'string' && Boolean(row.id.trim()));

function validServeReadResult(method, result) {
  return isRecord(result) && (method === 'gateway.ping' ? result.ok === true : validSessions(result.sessions));
}

function probeBudget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw probeFailure('offline');
    return remaining;
  };
}

// Race the entire operation, including response body consumption. Injected
// transports may ignore AbortSignal; the deadline still settles inspection.
async function boundedRead(read, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(probeFailure('offline')); }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(() => read(controller.signal)), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

async function probeJson(baseUrl, path, { fetchImpl, token, timeoutMs }) {
  return boundedRead(async signal => {
    let response;
    try {
      response = await fetchImpl(new URL(path, baseUrl), {
        method: 'GET', redirect: 'manual', signal,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      });
    } catch { throw probeFailure('offline'); }
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw probeFailure('incompatible');
    if (response.status === 401 || response.status === 403) throw probeFailure('auth_failed');
    if (response.status === 404 || response.status === 405) throw probeFailure('incompatible');
    if (!response.ok) throw probeFailure('offline');
    try { return await response.json(); }
    catch (error) { throw probeFailure(error instanceof SyntaxError ? 'incompatible' : 'offline'); }
  }, timeoutMs);
}

export async function probeServe(connection, { fetchImpl = fetch, rpcProbe, tokenProvider = readServeToken, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const remaining = probeBudget(timeoutMs);
  const profile = connection?.profile || 'default';
  const withoutIdentity = state => ({ state, profile });
  let baseUrl;
  try { baseUrl = assertLoopbackServeUrl(connection?.baseUrl).href; }
  catch { return withoutIdentity('incompatible'); }
  let token;
  try { token = await boundedRead(() => tokenProvider(connection), remaining()); }
  catch { return withoutIdentity('auth_missing'); }
  if (typeof token !== 'string' || !token.trim()) return withoutIdentity('auth_missing');

  let status;
  try { status = await probeJson(baseUrl, '/api/status', { fetchImpl, timeoutMs: remaining() }); }
  catch (error) { return withoutIdentity(error.probeState || 'offline'); }
  if (!isRecord(status) || typeof status.install_id !== 'string' || !status.install_id.trim()) return withoutIdentity('incompatible');
  if (typeof rpcProbe !== 'function') return withoutIdentity('incompatible');

  try {
    const safeConnection = { ...connection, baseUrl };
    for (const method of ['gateway.ping', 'session.list']) {
      const result = await boundedRead(signal => rpcProbe(safeConnection, { method, token, profile, signal }), remaining());
      if (!validServeReadResult(method, result)) return withoutIdentity('incompatible');
    }
  } catch (error) {
    return withoutIdentity(statusOf(error) === 401 || statusOf(error) === 403 ? 'auth_failed' : error.probeState || 'incompatible');
  }
  return { state: 'ready', installId: status.install_id, profile };
}

async function probeAuthenticatedReads(base, tokenProvider, reads, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const remaining = probeBudget(timeoutMs);
  const result = state => ({ state, profile: 'default' });
  let baseUrl;
  try { baseUrl = assertLoopbackServeUrl(base).href; }
  catch { return result('incompatible'); }
  let token;
  try { token = await boundedRead(tokenProvider, remaining()); }
  catch { return result('auth_missing'); }
  if (typeof token !== 'string' || !token.trim()) return result('auth_missing');
  try {
    for (const { path, valid } of reads) {
      const body = await probeJson(baseUrl, path, { fetchImpl, token, timeoutMs: remaining() });
      if (!valid(body)) return result('incompatible');
    }
    return result('ready');
  } catch (error) { return result(error.probeState || 'incompatible'); }
}

export async function probeStudio(baseUrl, options = {}) {
  const indexProfiles = new Map();
  let unresolved = false;
  const validProfile = profile => typeof profile === 'string' && Boolean(profile.trim());
  const validIndex = body => {
    if (!isRecord(body) || !validSessions(body.sessions)) return false;
    for (const row of body.sessions) {
      if (!validProfile(row.profile) || (indexProfiles.has(row.id) && indexProfiles.get(row.id) !== row.profile)) return false;
      indexProfiles.set(row.id, row.profile);
    }
    return true;
  };
  const validPage = body => {
    if (!isRecord(body) || !validSessions(body.sessions) ||
        (Object.hasOwn(body, 'hasMore') && typeof body.hasMore !== 'boolean') ||
        (Object.hasOwn(body, 'offset') && body.offset !== 0) ||
        (Object.hasOwn(body, 'limit') && (!Number.isInteger(body.limit) || body.limit <= 0)) ||
        (body.hasMore === true && (body.offset !== 0 || !Number.isInteger(body.limit) || body.limit <= 0))) return false;
    const canonicalProfiles = new Map();
    for (const row of body.sessions) {
      // The read adapter merges exact IDs with index-first precedence. Only a
      // genuinely absent field can rely on that index evidence; never assign a
      // default profile to an unknown row or override explicit contradictory data.
      const profile = Object.hasOwn(row, 'profile') ? row.profile : indexProfiles.get(row.id);
      const rowUnresolved = isUnresolvedStudioSession(row, indexProfiles);
      if ((!rowUnresolved && !validProfile(profile)) || (indexProfiles.has(row.id) && indexProfiles.get(row.id) !== profile) ||
          (canonicalProfiles.has(row.id) && canonicalProfiles.get(row.id) !== profile)) return false;
      canonicalProfiles.set(row.id, profile);
      unresolved ||= rowUnresolved;
    }
    return true;
  };
  const result = await probeAuthenticatedReads(baseUrl, options.tokenProvider, [
    { path: '/api/studio/sessions', valid: validIndex },
    { path: '/api/studio/sessions/hermes?offset=0&limit=1', valid: validPage },
  ], options);
  return result.state === 'ready' && unresolved ? { ...result, readWarning: 'studio_sessions_unresolved' } : result;
}

export function probeLegacy(baseUrl, options = {}) {
  return probeAuthenticatedReads(baseUrl, options.tokenProvider, [
    { path: '/api/sessions?source=api_server&limit=200', valid: body => isRecord(body) && Array.isArray(body.data) },
  ], options);
}
