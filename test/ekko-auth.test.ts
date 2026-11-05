import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
// @ts-expect-error runtime ESM helper has no declaration
import { assertEkkoBaseUrl, pairEkkoAccount, probeEkkoAccount } from '../scripts/ekko-auth.mjs';
// @ts-expect-error runtime ESM helper has no declaration
import { createEkkoConnectionStore } from '../scripts/ekko-private-file.mjs';

const baseUrl = 'http://127.0.0.1:8748';
const password = 'PASSWORD_TEST_ONLY_DO_NOT_LOG';
const token = 'TOKEN_TEST_ONLY_DO_NOT_LOG';

function mockApi({ deviceId = 'device-A', accountId = 7, accountName = 'Account A' } = {}) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    if (path === '/api/auth/app-login') {
      const body = JSON.parse(String(init.body));
      return Response.json({ token, userId: accountId, profiles: [], theme: {}, appConnection: { id: 11, device_code: body.device_code, token_expires_at: 1893456000 } });
    }
    if (path === '/api/auth/me') return Response.json({ user: { id: accountId, username: accountName } });
    if (path === '/api/devices/link-info') return Response.json({ device_id: deviceId });
    throw new Error('Unexpected endpoint');
  };
  return { fetchImpl, calls };
}

async function withStore(run: (store: ReturnType<typeof createEkkoConnectionStore>, filePath: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'siyuan-ekko-test-'));
  const filePath = join(dir, 'private', 'connection.json');
  try { await run(createEkkoConnectionStore({ filePath }), filePath); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('EKKO base URL accepts only explicit IPv4 loopback HTTP with a port', () => {
  assert.equal(assertEkkoBaseUrl(baseUrl).origin, baseUrl);
  for (const value of ['http://localhost:8748', 'http://localhost.evil:8748', 'http://192.168.1.2:8748', 'https://127.0.0.1:8748', 'http://user:pass@127.0.0.1:8748', 'http://127.0.0.1', 'http://127.0.0.1:8748/path']) {
    assert.throws(() => assertEkkoBaseUrl(value), /EKKO.*address/i);
  }
});

test('pairing uses one app-login with a fresh code, checks identity, stores no password, and returns no token or file path', async () => {
  await withStore(async (store, filePath) => {
    const api = mockApi();
    const view = await pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl: api.fetchImpl, store });
    assert.equal(api.calls.map(c => c.path).join(','), '/api/auth/app-login,/api/auth/me,/api/devices/link-info');
    const login = api.calls[0];
    const body = JSON.parse(String(login.init.body));
    assert.equal(login.init.method, 'POST');
    assert.equal(login.init.redirect, 'error');
    assert.equal(body.username, 'Account A');
    assert.equal(body.password, password);
    assert.equal(body.device_name, 'SiYuan AI Work');
    assert.match(body.device_code, /^[a-f0-9-]{32,}$/);
    assert.equal(new Set(api.calls.map(c => c.init.redirect)).size, 1);
    assert.equal(new Headers(api.calls[1].init.headers).get('Authorization'), `Bearer ${token}`);
    assert.equal(view.accountUserId, 7);
    assert.equal(view.deviceId, 'device-A');
    assert.equal(view.accountName, 'Account A');
    assert.equal('token' in view, false);
    assert.equal('filePath' in view, false);
    assert.equal(JSON.stringify(view).includes(token), false);
    const raw = await readFile(filePath, 'utf8');
    assert.equal(raw.includes(password), false);
    assert.equal(JSON.parse(raw).token, token);
  });
});

test('same device and account keep the connection ID; changed device or account gets a new one', async () => {
  await withStore(async (store) => {
    const pair = (deviceId: string, accountId: number) => pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl: mockApi({ deviceId, accountId }).fetchImpl, store });
    const first = await pair('device-A', 7);
    const renewal = await pair('device-A', 7);
    const changedDevice = await pair('device-B', 7);
    const changedAccount = await pair('device-B', 8);
    assert.equal(renewal.connectionId, first.connectionId);
    assert.notEqual(changedDevice.connectionId, first.connectionId);
    assert.notEqual(changedAccount.connectionId, changedDevice.connectionId);
  });
});

test('same device and account keep the connection ID when the loopback port changes', async () => {
  await withStore(async (store) => {
    const first = await pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl: mockApi().fetchImpl, store });
    const renewed = await pairEkkoAccount({ baseUrl: 'http://127.0.0.1:8749', username: 'Account A', password, fetchImpl: mockApi().fetchImpl, store });
    assert.equal(renewed.connectionId, first.connectionId);
    assert.equal(renewed.baseUrl, 'http://127.0.0.1:8749');
  });
});

test('redirects are rejected at every auth endpoint before writing', async () => {
  for (const redirectAt of ['/api/auth/app-login', '/api/auth/me', '/api/devices/link-info']) {
    await withStore(async (store) => {
      const api = mockApi();
      const fetchImpl = async (url: string, init: RequestInit) => new URL(url).pathname === redirectAt
        ? new Response('', { status: 302, headers: { Location: 'http://outside.example/' } })
        : api.fetchImpl(url, init);
      await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl, store }), /EKKO|redirect/i);
      assert.equal(await store.read(), null);
    });
  }
});

test('uncertain app-login failure is not retried and is identified without credentials', async () => {
  await withStore(async (store) => {
    let attempts = 0;
    const fetchImpl = async () => { attempts++; throw new Error(`network timeout ${password} ${token}`); };
    await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl, store }), (error: any) => {
      assert.equal(error.code, 'ekko_pairing_unresolved');
      assert.equal(String(error.message).includes(password), false);
      assert.equal(String(error.message).includes(token), false);
      return true;
    });
    assert.equal(attempts, 1);
    assert.equal(await store.read(), null);
  });
});

test('identity request failure never exposes fetch error text containing credentials', async () => {
  await withStore(async (store) => {
    const api = mockApi();
    const fetchImpl = async (url: string, init: RequestInit) => new URL(url).pathname === '/api/auth/me'
      ? Promise.reject(new Error(`identity timeout ${password} ${token}`))
      : api.fetchImpl(url, init);
    await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl, store }), (error: any) => {
      assert.equal(error.code, 'ekko_pairing_unresolved');
      assert.equal(error.reasonCode, 'ekko_transport_unknown');
      assert.match(error.message, /application connection.*check/i);
      assert.equal(String(error.message).includes(password), false);
      assert.equal(String(error.message).includes(token), false);
      return true;
    });
    assert.equal(await store.read(), null);
  });
});

test('accepted app-login with broken or invalid response remains unresolved with a safe reason', async () => {
  for (const [invalid, reason] of [
    [new Response('{', { status: 200 }), 'ekko_invalid_response'],
    [Response.json({ token, userId: 7, appConnection: { id: 11 } }), 'ekko_app_login_payload_invalid']
  ] as const) {
    await withStore(async (store) => {
      const fetchImpl = async () => invalid;
      await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl, store }), (error: any) => {
        assert.equal(error.code, 'ekko_pairing_unresolved');
        assert.equal(error.reasonCode, reason);
        assert.match(error.message, /invalid.*application connection.*check/i);
        assert.equal(error.message.includes(token), false);
        return true;
      });
      assert.equal(await store.read(), null);
    });
  }
});

test('malformed identity data after app-login remains unresolved with an identity-specific reason', async () => {
  await withStore(async (store) => {
    const api = mockApi();
    const fetchImpl = async (url: string, init: RequestInit) => new URL(url).pathname === '/api/devices/link-info'
      ? Response.json({ device_id: '' })
      : api.fetchImpl(url, init);
    await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl, store }), (error: any) => {
      assert.equal(error.code, 'ekko_pairing_unresolved');
      assert.equal(error.reasonCode, 'ekko_identity_response_invalid');
      assert.match(error.message, /identity.*invalid.*application connection.*check/i);
      return true;
    });
    assert.equal(await store.read(), null);
  });
});

test('identity rejection or mismatch after app-login remains unresolved with its reason', async () => {
  for (const scenario of ['rejected', 'mismatch']) {
    await withStore(async (store) => {
      const api = mockApi({ accountId: scenario === 'mismatch' ? 8 : 7 });
      const fetchImpl = async (url: string, init: RequestInit) => {
        if (scenario === 'rejected' && new URL(url).pathname === '/api/auth/me') return new Response('', { status: 401 });
        if (scenario === 'mismatch' && new URL(url).pathname === '/api/auth/app-login') {
          const body = JSON.parse(String(init.body));
          return Response.json({ token, userId: 7, appConnection: { id: 11, device_code: body.device_code, token_expires_at: 1893456000 } });
        }
        return api.fetchImpl(url, init);
      };
      await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl, store }), (error: any) => {
        assert.equal(error.code, 'ekko_pairing_unresolved');
        assert.equal(error.reasonCode, scenario === 'rejected' ? 'ekko_auth_failed' : 'ekko_identity_changed');
        assert.match(error.message, /application connection.*check/i);
        return true;
      });
      assert.equal(await store.read(), null);
    });
  }
});

test('server error after app-login submission remains unresolved without retry', async () => {
  await withStore(async (store) => {
    let attempts = 0;
    const fetchImpl = async () => { attempts++; return new Response('', { status: 503 }); };
    await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl, store }), (error: any) => error.code === 'ekko_pairing_unresolved');
    assert.equal(attempts, 1);
    assert.equal(await store.read(), null);
  });
});

test('private write failure after app-login requires connection review and hides credentials', async () => {
  const api = mockApi();
  const store = { read: async () => null, write: async () => { throw new Error(`${password} ${token}`); } };
  await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl: api.fetchImpl, store }), (error: any) => {
    assert.equal(error.code, 'ekko_pairing_unresolved');
    assert.equal(String(error.message).includes(password), false);
    assert.equal(String(error.message).includes(token), false);
    return true;
  });
  assert.equal(api.calls.filter(c => c.path === '/api/auth/app-login').length, 1);
});

test('probe authenticates saved identity and refuses device or account changes', async () => {
  await withStore(async (store) => {
    const initial = await pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl: mockApi().fetchImpl, store });
    const connection = await store.read();
    const view = await probeEkkoAccount({ connection, fetchImpl: mockApi().fetchImpl });
    assert.equal(view.connectionId, initial.connectionId);
    assert.equal('token' in view, false);
    for (const change of [{ deviceId: 'device-B' }, { accountId: 8 }]) {
      await assert.rejects(probeEkkoAccount({ connection, fetchImpl: mockApi(change).fetchImpl }), /identity/i);
    }
  });
});

test('private store writes only the approved connection fields', async () => {
  await withStore(async (store, filePath) => {
    await pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl: mockApi().fetchImpl, store });
    const connection = await store.read();
    await store.write({ ...connection, password });
    assert.equal((await readFile(filePath, 'utf8')).includes(password), false);
  });
});

test('private store rejects an existing file with insecure permissions before login', async () => {
  await withStore(async (store, filePath) => {
    await mkdir(dirname(filePath), { recursive: true });
    const record = { connectionId: 'local-1', baseUrl, deviceId: 'device-A', accountUserId: 7, accountName: 'Account A', appConnectionId: 11, token, expiresAt: 1893456000 };
    await writeFile(filePath, JSON.stringify(record), { mode: 0o644 });
    if (process.platform !== 'win32') await chmod(filePath, 0o644);
    await assert.rejects(store.read(), /permission/i);
    const api = mockApi();
    await assert.rejects(pairEkkoAccount({ baseUrl, username: 'Account A', password, fetchImpl: api.fetchImpl, store }), /permission/i);
    assert.equal(api.calls.length, 0);
  });
});
