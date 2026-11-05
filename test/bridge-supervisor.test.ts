import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error runtime ESM helper has no declaration
import { backoffDelay, acquireInstanceLock, probeHealth, runSupervisor } from '../scripts/bridge-supervisor.mjs';

test('backoff grows after failed exits and is capped', () => {
  assert.equal(backoffDelay(0, { baseMs: 100, maxMs: 1000 }), 100);
  assert.equal(backoffDelay(1, { baseMs: 100, maxMs: 1000 }), 200);
  assert.equal(backoffDelay(8, { baseMs: 100, maxMs: 1000 }), 1000);
});

test('instance lock prevents a second supervisor and releases on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-supervisor-'));
  const path = join(dir, 'bridge.lock');
  const first = await acquireInstanceLock(path);
  await assert.rejects(() => acquireInstanceLock(path), /already running/);
  await first.release();
  const second = await acquireInstanceLock(path);
  await second.release();
  await rm(dir, { recursive: true, force: true });
});

test('health probe returns status and rejects unavailable service', async () => {
  const server = await import('node:http').then(({ createServer }) => new Promise<any>(resolve => {
    const s = createServer((_req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  }));
  const port = (server.address() as any).port;
  assert.equal((await probeHealth(port)).status, 200);
  await new Promise<void>((resolve, reject) => server.close((error?: Error) => error ? reject(error) : resolve()));
  await assert.rejects(() => probeHealth(port), (error: unknown) =>
    error instanceof Error && (
      ['ECONNREFUSED', 'ECONNRESET'].includes((error as NodeJS.ErrnoException).code ?? '') ||
      error.message === 'timeout'
    ));
});

test('supervisor restarts an exited child with backoff and stops gracefully', async () => {
  const events: string[] = [];
  let launches = 0;
  const result = await runSupervisor({
    lockPath: join(await mkdtemp(join(tmpdir(), 'bridge-supervisor-')), 'bridge.lock'),
    spawnChild: () => { launches++; events.push(`start-${launches}`); return { once: (event: string, cb: () => void) => { if (event === 'exit') setTimeout(cb, 2); }, kill: () => events.push('kill') } as any; },
    health: async () => ({ status: 200 }),
    sleep: async () => {},
    maxRestarts: 2,
    stopAfterRestarts: true,
  });
  assert.equal(result.restarts, 2);
  assert.equal(launches, 3);
  assert.deepEqual(events, ['start-1', 'start-2', 'start-3', 'kill']);
});
