import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- plain Node ESM module has no declaration file.
import { assertLoopbackServeUrl, connectionRegistry, readServeToken, probeServe } from '../scripts/hermes-connections.mjs';

const serve = () => connectionRegistry({
  SIYUAN_HERMES_SERVE_URL: 'http://127.0.0.1:9119',
  SIYUAN_HERMES_SERVE_PROFILE: 'default',
}).connections[0];

test('registry fixes the three connection identities without a token value', () => {
  assert.deepEqual(connectionRegistry({}), {
    defaultConnectionId: 'serve-local',
    connections: [
      { id: 'serve-local', kind: 'serve', baseUrl: 'http://127.0.0.1:9119/', profile: 'default', tokenFile: '' },
      { id: 'studio-default', kind: 'studio', profile: 'default' },
      { id: 'legacy-api', kind: 'legacy-api', profile: 'default' },
    ],
  });
});

test('Serve URL accepts only an uncredentialed HTTP 127.0.0.1 origin', () => {
  assert.equal(assertLoopbackServeUrl('http://127.0.0.1:9119').href, 'http://127.0.0.1:9119/');
  for (const raw of [
    'http://localhost.evil:9119', 'http://user@127.0.0.1:9119',
    'http://127.0.0.1:9119/other', 'http://127.0.0.1:9119/?q=1',
    'http://127.0.0.1:9119/#part', 'http://192.168.1.1:9119',
    'http://localhost:9119', 'https://127.0.0.1:9119',
  ]) assert.throws(() => assertLoopbackServeUrl(raw), /回环|地址/);
});

test('missing server-side token returns auth_missing without contacting the service', async () => {
  let called = false;
  const result = await probeServe(serve(), {
    fetchImpl: async () => { called = true; throw new Error('unexpected'); },
    rpcProbe: async () => { called = true; },
    tokenProvider: async () => '',
  });
  assert.deepEqual(result, { state: 'auth_missing', profile: 'default' });
  assert.equal(called, false);
});

test('status without install_id is incompatible and does not call RPC', async () => {
  let rpcCalled = false;
  const result = await probeServe(serve(), {
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    rpcProbe: async () => { rpcCalled = true; },
    tokenProvider: async () => 'test-token',
  });
  assert.deepEqual(result, { state: 'incompatible', profile: 'default' });
  assert.equal(rpcCalled, false);
});

test('status 401 returns auth_failed without exposing upstream body', async () => {
  const result = await probeServe(serve(), {
    fetchImpl: async () => new Response('test-token', { status: 401 }),
    rpcProbe: async () => {},
    tokenProvider: async () => 'test-token',
  });
  assert.deepEqual(result, { state: 'auth_failed', profile: 'default' });
});

test('status redirect is rejected without following it', async () => {
  const result = await probeServe(serve(), {
    fetchImpl: async (_url: unknown, init: RequestInit) => {
      assert.equal(init.redirect, 'manual');
      assert.ok(init.signal);
      return new Response('', { status: 302, headers: { Location: 'https://outside.example/' } });
    },
    rpcProbe: async () => { throw new Error('RPC should not run'); },
    tokenProvider: async () => 'test-token',
  });
  assert.deepEqual(result, { state: 'incompatible', profile: 'default' });
});

test('a changed connection URL cannot make the probe contact a remote host', async () => {
  let called = false;
  const result = await probeServe({ ...serve(), baseUrl: 'http://outside.example/' }, {
    fetchImpl: async () => { called = true; throw new Error('unexpected'); },
    rpcProbe: async () => { called = true; },
    tokenProvider: async () => 'test-token',
  });
  assert.deepEqual(result, { state: 'incompatible', profile: 'default' });
  assert.equal(called, false);
});

test('RPC authorization failure is classified without exposing exception details', async () => {
  const result = await probeServe(serve(), {
    fetchImpl: async () => new Response(JSON.stringify({ install_id: 'install-1' }), { status: 200 }),
    rpcProbe: async () => { throw Object.assign(new Error('test-token'), { status: 401 }); },
    tokenProvider: async () => 'test-token',
  });
  assert.deepEqual(result, { state: 'auth_failed', profile: 'default' });
  assert.equal(JSON.stringify(result).includes('test-token'), false);
});

test('ready requires both read-only RPC methods after status identity', async () => {
  const methods: string[] = [];
  const result = await probeServe(serve(), {
    fetchImpl: async (url: unknown, init: RequestInit) => {
      assert.equal(String(url), 'http://127.0.0.1:9119/api/status');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'manual');
      assert.equal((init.headers as Record<string, string>)?.Authorization, undefined);
      return new Response(JSON.stringify({ install_id: 'install-1' }), { status: 200 });
    },
    rpcProbe: async (_connection: unknown, input: { method: string; token: string; profile: string }) => {
      assert.equal(input.token, 'test-token');
      assert.equal(input.profile, 'default');
      methods.push(input.method);
      return input.method === 'gateway.ping' ? { ok: true } : { sessions: [] };
    },
    tokenProvider: async () => 'test-token',
  });
  assert.deepEqual(methods, ['gateway.ping', 'session.list']);
  assert.deepEqual(result, { state: 'ready', installId: 'install-1', profile: 'default' });
});

test('token reads only the configured private file and missing file stays missing', async () => {
  assert.equal(await readServeToken({ tokenFile: '' }), '');
  assert.equal(await readServeToken({ tokenFile: 'Z:/definitely-missing-token-file' }), '');
});

for (const method of ['gateway.ping', 'session.list']) test(`undefined ${method} reply does not prove helper readiness`, async () => {
  const result = await probeServe(serve(), {
    fetchImpl: async () => Response.json({ install_id: 'install-1' }),
    rpcProbe: async (_connection: unknown, input: { method: string }) => input.method === method ? undefined : { ok: true, sessions: [] },
    tokenProvider: async () => 'test-token',
  });
  assert.deepEqual(result, { state: 'incompatible', profile: 'default' });
});
