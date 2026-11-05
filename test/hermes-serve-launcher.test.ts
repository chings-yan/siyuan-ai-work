import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain Node ESM launcher has no declaration file.
import { launchHermesServe, setupServeToken, runOwnedServe, tokenFileIsPrivate, verifyOwnedChild } from '../scripts/hermes-serve-launcher.mjs';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-launcher-test-'));
  dirs.push(dir);
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, 'fictional-secret');
  return tokenFile;
}
function options(tokenFile: string, changes: Record<string, unknown> = {}) {
  return { hermesCommand: 'hermes', port: 9119, tokenFile, expectedInstallId: 'installation-a',
    tokenFileIsPrivate: async () => true, portOccupied: async () => false,
    probe: async () => ({ state: 'offline' }), spawnChild: () => ({ pid: 321 }),
    logger: { info() {}, warn() {} }, ...changes };
}

test('setup creates one private token and preserves it on repeat without logging secret', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-launcher-test-')); dirs.push(dir);
  const tokenFile = join(dir, 'private', 'token');
  let hardened = 0; let privateChecks = 0; let log = '';
  const input = { tokenFile, setTokenFilePrivate: async () => { assert.equal((await readFile(tokenFile, 'utf8')).length, 0); hardened++; },
    tokenFileIsPrivate: async () => { if (privateChecks++ === 0) assert.equal((await readFile(tokenFile, 'utf8')).length, 0); return true; },
    directoryIsPrivate: async () => true, setDirectoryPrivate: async () => {},
    logger: { info: (s: string) => { log += s; } } };
  await setupServeToken(input);
  const first = await readFile(tokenFile, 'utf8');
  await setupServeToken(input);
  assert.ok(first.length >= 40);
  assert.equal(await readFile(tokenFile, 'utf8'), first);
  assert.equal(hardened, 1);
  assert.doesNotMatch(log, new RegExp(first));
});

test('real setup secures a temporary token file using platform permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-launcher-test-')); dirs.push(dir);
  const tokenFile = join(dir, 'private', 'private-token');
  await setupServeToken({ tokenFile });
  assert.equal(await tokenFileIsPrivate(tokenFile), true);
});

test('setup does not write a token before file hardening and removes a failed new file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-launcher-test-')); dirs.push(dir);
  const tokenFile = join(dir, 'token');
  await assert.rejects(setupServeToken({ tokenFile, directoryIsPrivate: async () => true,
    setTokenFilePrivate: async () => { assert.equal((await readFile(tokenFile, 'utf8')).length, 0); throw new Error('harden failed'); },
  }), /harden failed/);
  await assert.rejects(stat(tokenFile), { code: 'ENOENT' });
});

test('setup fails closed on an insecure existing directory and preserves an existing blank token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-launcher-test-')); dirs.push(dir);
  const tokenFile = join(dir, 'token');
  await assert.rejects(setupServeToken({ tokenFile, directoryIsPrivate: async () => false }), /目录.*权限|私有/);
  await assert.rejects(stat(tokenFile), { code: 'ENOENT' });
  await writeFile(tokenFile, '');
  await assert.rejects(setupServeToken({ tokenFile, directoryIsPrivate: async () => true,
    tokenFileIsPrivate: async () => true,
    setTokenFilePrivate: async () => { throw new Error('existing token must not be changed'); },
  }), /空|令牌/);
  assert.equal(await readFile(tokenFile, 'utf8'), '');
});

test('cleanup failure is reported and does not hide the original setup failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-launcher-test-')); dirs.push(dir);
  const tokenFile = join(dir, 'token');
  await assert.rejects(setupServeToken({ tokenFile, directoryIsPrivate: async () => true,
    setTokenFilePrivate: async () => { throw new Error('harden failed'); },
    removeCreatedToken: async () => { throw new Error('remove failed'); },
  }), /清理失败.*harden failed/);
  assert.equal(await readFile(tokenFile, 'utf8'), '');
});

test('missing or insecure token prevents launch', async () => {
  const tokenFile = await fixture(); let spawned = 0;
  const spawnChild = () => { spawned++; return { pid: 321 }; };
  await assert.rejects(launchHermesServe(options(`${tokenFile}-absent`, { spawnChild })), /令牌/);
  await assert.rejects(launchHermesServe(options(tokenFile, { spawnChild, tokenFileIsPrivate: async () => false })), /权限|私有/);
  assert.equal(spawned, 0);
});

test('occupied port attaches only to authenticated matching installation', async () => {
  const tokenFile = await fixture(); let spawned = 0;
  const spawnChild = () => { spawned++; return { pid: 321 }; };
  const base = options(tokenFile, { portOccupied: async () => true, spawnChild });
  assert.deepEqual(await launchHermesServe({ ...base, probe: async () => ({ state: 'ready', installId: 'installation-a' }) }), { owned: false });
  await assert.rejects(launchHermesServe({ ...base, expectedInstallId: undefined, probe: async () => ({ state: 'ready', installId: 'installation-a' }) }), /安装|身份/);
  await assert.rejects(launchHermesServe({ ...base, probe: async () => ({ state: 'ready', installId: 'other' }) }), /占用|安装/);
  await assert.rejects(launchHermesServe({ ...base, probe: async () => ({ state: 'offline' }) }), /占用|身份/);
  assert.equal(spawned, 0);
});

test('free port starts loopback child with token only in environment', async () => {
  const tokenFile = await fixture(); let spawnArgs: any[] = []; let log = '';
  const result = await launchHermesServe(options(tokenFile, { spawnChild: (...args: any[]) => { spawnArgs = args; return { pid: 456 }; },
    logger: { info: (s: string) => { log += s; }, warn: (s: string) => { log += s; } } }));
  assert.deepEqual(result, { owned: true, pid: 456 });
  assert.deepEqual(spawnArgs[1], ['serve', '--host', '127.0.0.1', '--port', '9119']);
  assert.equal(spawnArgs[2].env.HERMES_DASHBOARD_SESSION_TOKEN, 'fictional-secret');
  assert.doesNotMatch(JSON.stringify(spawnArgs.slice(0, 2)) + log, /fictional-secret/);
});

test('foreground restarts only an owned child, never an attached service', async () => {
  let calls = 0;
  await runOwnedServe({ launch: async () => { calls++; return { owned: false }; }, waitForExit: async () => {} });
  assert.equal(calls, 1);
  await runOwnedServe({ launch: async () => ({ owned: true, pid: ++calls }), verifyOwned: async () => true, waitForExit: async () => ({ code: 1 }), shouldContinue: () => calls < 3 });
  assert.equal(calls, 3);
});

test('foreground verifies its newly started service before treating it as healthy', async () => {
  const steps: string[] = [];
  await assert.rejects(runOwnedServe({
    launch: async () => { steps.push('launch'); return { owned: true, pid: 42 }; },
    verifyOwned: async () => { steps.push('probe'); throw new Error('health unavailable'); },
    waitForExit: async () => { steps.push('wait'); },
  }), /health unavailable/);
  assert.deepEqual(steps, ['launch', 'probe']);
});


test('configuration refusal 78 stops the owned restart loop with an actionable error', async () => {
  let launches = 0;
  await assert.rejects(runOwnedServe({
    launch: async () => ({ owned: true, pid: ++launches }),
    verifyOwned: async () => true,
    waitForExit: async () => ({ code: 78 }),
    shouldContinue: () => launches < 2,
  }), /78|配置|端点/);
  assert.equal(launches, 1);
});

test('unverified startup including exit zero cannot be reported healthy or restarted', async () => {
  for (const code of [0, 78, 1]) {
    let launches = 0; let waited = 0;
    await assert.rejects(runOwnedServe({
      launch: async () => ({ owned: true, pid: ++launches }),
      verifyOwned: async () => ({ ready: false, code }),
      waitForExit: async () => { waited++; return { code }; },
      shouldContinue: () => launches < 2,
    }), /启动|健康|配置/);
    assert.equal(launches, 1);
    assert.equal(waited, 0);
  }
});

test('actual child readiness verifier rejects an early exit and never probes a refused child', async () => {
  assert.equal(typeof verifyOwnedChild, 'function', 'actual main readiness logic must be testable');
  for (const code of [78, 0, 1]) {
    let probes = 0;
    await assert.rejects(verifyOwnedChild({
      child: { exitCode: code, signalCode: null }, childExit: Promise.resolve({ code }),
      probe: async () => { probes++; return { state: 'ready', installId: 'installation-a' }; },
    }), code === 78 ? /78|配置|端点/ : /启动|健康/);
    assert.equal(probes, 0);
  }
});

test('actual readiness verifier accepts proof then checks an exit during a pending probe', async () => {
  const child = { exitCode: null as number | null, signalCode: null, kill() { throw new Error('verified child must not be killed'); } };
  assert.equal(await verifyOwnedChild({ child, childExit: new Promise(() => {}), expectedInstallId: 'installation-a',
    probe: async () => ({ state: 'ready', installId: 'installation-a' }) }), true);
  await assert.rejects(verifyOwnedChild({ child, childExit: new Promise(() => {}),
    probe: async () => { child.exitCode = 0; return { state: 'ready', installId: 'installation-a' }; } }), /启动.*失败/);
});

test('never-ready owned child fails at a bounded deadline and kills only that child', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let kills = 0; let probes = 0;
  const child = { exitCode: null, signalCode: null, kill() { kills++; } };
  const result = verifyOwnedChild({ child, childExit: new Promise(() => {}), timeoutMs: 100, pollMs: 50,
    probe: async () => { probes++; return { state: 'offline' }; } });
  const rejected = assert.rejects(result, /健康检查超时/);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  t.mock.timers.tick(100);
  await rejected;
  t.mock.timers.tick(1000);
  assert.equal(kills, 1);
  assert.equal(probes, 1);
});

test('owned-child exit during a stuck probe is startup failure without waiting for the deadline', async () => {
  let resolveExit: any;
  const childExit = new Promise(resolve => { resolveExit = resolve; });
  const child = { exitCode: null, signalCode: null, kill() { throw new Error('already exited'); } };
  const result = verifyOwnedChild({ child, childExit, probe: () => new Promise(() => {}) });
  const rejected = assert.rejects(result, /78|配置/);
  resolveExit({ code: 78 });
  await rejected;
});
