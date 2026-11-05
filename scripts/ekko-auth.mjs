import { randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT_MS = 10_000;

function failure(code, message) { return Object.assign(new Error(message), { code }); }

function pairingUnresolved(error) {
  const reasons = {
    ekko_transport_unknown: 'EKKO request result is unknown',
    ekko_redirect_denied: 'EKKO redirected a pairing request',
    ekko_invalid_response: 'EKKO returned an invalid response',
    ekko_app_login_payload_invalid: 'EKKO application login response is invalid',
    ekko_identity_response_invalid: 'EKKO identity response is invalid',
    ekko_auth_failed: 'EKKO identity authentication failed',
    ekko_request_failed: 'EKKO identity request failed',
    ekko_identity_changed: 'EKKO account identity did not match',
    ekko_private_store_failed: 'EKKO private connection could not be saved securely'
  };
  const reasonCode = Object.hasOwn(reasons, error?.code) ? error.code : 'ekko_unknown_failure';
  const detail = reasons[reasonCode] || 'EKKO pairing could not be completed';
  return Object.assign(failure('ekko_pairing_unresolved', `${detail}; EKKO application connection may have been created; check EKKO application connections before retrying`), { reasonCode });
}

export function assertEkkoBaseUrl(raw) {
  try {
    if (typeof raw !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/??$/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url;
  } catch { throw failure('ekko_invalid_address', 'EKKO address must be a local HTTP address with an explicit port'); }
}

function connectionView(connection) {
  return {
    connectionId: connection.connectionId,
    baseUrl: connection.baseUrl,
    deviceId: connection.deviceId,
    accountUserId: connection.accountUserId,
    accountName: connection.accountName,
    appConnectionId: connection.appConnectionId,
    expiresAt: connection.expiresAt
  };
}

async function requestJson(fetchImpl, baseUrl, path, { method = 'GET', token, body } = {}) {
  let response;
  try {
    response = await fetchImpl(new URL(path, baseUrl).href, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw failure('ekko_transport_unknown', 'EKKO request result is unknown');
  }
  if (response.status >= 300 && response.status < 400) throw failure('ekko_redirect_denied', 'EKKO redirect was refused');
  if (!response.ok) throw failure(response.status >= 500 ? 'ekko_transport_unknown' : response.status === 401 || response.status === 403 ? 'ekko_auth_failed' : 'ekko_request_failed', 'EKKO authentication or identity check failed');
  try { return await response.json(); }
  catch { throw failure('ekko_invalid_response', 'EKKO returned an invalid response'); }
}

async function verifiedIdentity({ baseUrl, token, fetchImpl }) {
  const me = await requestJson(fetchImpl, baseUrl, '/api/auth/me', { token });
  const link = await requestJson(fetchImpl, baseUrl, '/api/devices/link-info', { token });
  if (!Number.isSafeInteger(me?.user?.id) || me.user.id <= 0 || typeof me.user.username !== 'string' || !me.user.username || typeof link?.device_id !== 'string' || !link.device_id) {
    throw failure('ekko_identity_response_invalid', 'EKKO identity response is invalid');
  }
  return { accountUserId: me.user.id, accountName: me.user.username, deviceId: link.device_id };
}

export async function pairEkkoAccount({ baseUrl: rawBaseUrl, username, password, fetchImpl = fetch, store }) {
  const baseUrl = assertEkkoBaseUrl(rawBaseUrl).origin;
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password || !store?.read || !store?.write) {
    throw failure('ekko_pairing_input_invalid', 'EKKO account pairing input is invalid');
  }
  const previous = await store.read();
  const deviceCode = randomUUID();
  let login;
  try {
    login = await requestJson(fetchImpl, baseUrl, '/api/auth/app-login', { method: 'POST', body: { username, password, device_code: deviceCode, device_name: 'SiYuan AI Work' } });
  } catch (error) {
    if (error?.code === 'ekko_auth_failed' || error?.code === 'ekko_request_failed') throw error;
    throw pairingUnresolved(error);
  }
  try {
    const app = login?.appConnection;
    if (typeof login?.token !== 'string' || !login.token || !Number.isSafeInteger(login.userId) || login.userId <= 0 || !Number.isSafeInteger(app?.id) || app.id <= 0 || app.device_code !== deviceCode || !Number.isSafeInteger(app.token_expires_at) || app.token_expires_at <= Math.floor(Date.now() / 1000)) {
      throw failure('ekko_app_login_payload_invalid', 'EKKO application login response is invalid');
    }
    const identity = await verifiedIdentity({ baseUrl, token: login.token, fetchImpl });
    if (identity.accountUserId !== login.userId) throw failure('ekko_identity_changed', 'EKKO account identity does not match the application connection');
    const connection = {
      connectionId: previous?.deviceId === identity.deviceId && previous.accountUserId === identity.accountUserId ? previous.connectionId : randomUUID(),
      baseUrl,
      ...identity,
      appConnectionId: app.id,
      token: login.token,
      expiresAt: app.token_expires_at
    };
    try { await store.write(connection); }
    catch { throw failure('ekko_private_store_failed', 'EKKO private connection could not be saved securely'); }
    return connectionView(connection);
  } catch (error) {
    throw pairingUnresolved(error);
  }
}

export async function probeEkkoAccount({ connection, fetchImpl = fetch }) {
  if (!connection || typeof connection.token !== 'string' || !connection.token) throw failure('ekko_connection_missing', 'EKKO connection is unavailable');
  const baseUrl = assertEkkoBaseUrl(connection.baseUrl).origin;
  const identity = await verifiedIdentity({ baseUrl, token: connection.token, fetchImpl });
  if (identity.deviceId !== connection.deviceId || identity.accountUserId !== connection.accountUserId) throw failure('ekko_identity_changed', 'EKKO device or account identity changed');
  return connectionView({ ...connection, accountName: identity.accountName });
}
