import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- declaration resolution for the plain Node ESM bridge is not available here.
import { createBridgeServer } from '../scripts/bridge.mjs';

const CAPABILITY = 'c'.repeat(64);
const INVALID_ROOT = 'doc';
type FetchInput = string | URL | Request;

const routes = [
  { name: 'legacy sessions', path: '/sessions', method: 'GET' },
  { name: 'Studio sessions', path: '/studio/sessions', method: 'GET' },
  { name: 'Studio binding', path: '/studio/bind', method: 'POST' },
] as const;

async function openBridge(fetchImpl: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-root-'));
  const { server } = createBridgeServer({
    capability: CAPABILITY,
    fetchImpl,
    hermesBase: 'http://hermes',
    studioBase: 'http://studio',
    bindingsFile: join(directory, 'bindings.json'),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    server,
    directory,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeBridge(server: ReturnType<typeof createBridgeServer>['server'], directory: string) {
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}

for (const route of routes) {
  test(`rejects an invalid document root before ${route.name} calls upstream`, async () => {
    const calls: string[] = [];
    const bridge = await openBridge(async (url: FetchInput) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [], sessions: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const response = await fetch(`${bridge.url}${route.path}`, {
        method: route.method,
        headers: {
          'Content-Type': 'application/json',
          'X-Siyuan-Collab-Token': CAPABILITY,
          'X-Siyuan-Document-Root': INVALID_ROOT,
          Origin: 'http://127.0.0.1:6806',
        },
        body: route.method === 'POST' ? JSON.stringify({ session_id: 's1' }) : undefined,
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'invalid_document_root');
      assert.deepEqual(calls, []);
    } finally {
      await closeBridge(bridge.server, bridge.directory);
    }
  });
}

test('health remains available without a document root', async () => {
  const calls: string[] = [];
  const bridge = await openBridge(async (url: FetchInput) => {
    calls.push(String(url));
    return new Response('{}', { status: 200 });
  });
  try {
    const response = await fetch(`${bridge.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'siyuan-ai-collab-bridge' });
    assert.deepEqual(calls, []);
  } finally {
    await closeBridge(bridge.server, bridge.directory);
  }
});
