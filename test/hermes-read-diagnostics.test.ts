import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
// @ts-expect-error -- runtime ESM route module.
import { createBridgeServer } from '../scripts/bridge.mjs';

const project = resolve(import.meta.dirname, '..');
const target = join(project, 'scripts/diagnose-hermes-read.mjs');
const execute = promisify(execFile);
const cap = 'synthetic-bridge-credential-'.repeat(4), token = 'synthetic-studio-credential';
const forbidden = ['synthetic-private-id', 'synthetic-private-profile', 'synthetic-private-title', 'synthetic-private-body', cap, token];
const resp = (body: unknown, status = 200) => Response.json(body, { status });
// Public fingerprints independently checked against the historical edf build.
const cloudSha = 'e4ee2e69f054d5a390a96a6361cf02f97f02519ae6754ddf6bdfc74ec082ae30';
const localSha = 'efc8385fe278c9c7d297c266f9d2c508c9032c8086b183f39d697a87bcc2e9dc';
const installationRecord = { sourceCommit: 'edf984b43ba7d4b2e1886d5cc51e3bd2dae44a3e', pluginVersion: '0.3.5', recordedPublicBridgeSha256: localSha };
const companionManifest = { schemaVersion: 1, pluginName: 'siyuan-ai-collab', pluginVersion: '0.3.5', track: 'shared-service' };
async function identityRules() {
  const module = await import(pathToFileURL(target).href);
  assert.equal(typeof module.verifyPackageIdentity, 'function', 'historical installation record verification is missing');
  return module.verifyPackageIdentity;
}

test('known historical local build needs its explicit installation record and valid manifest', async () => {
  const verify = await identityRules();
  assert.deepEqual(verify(localSha, installationRecord, companionManifest), {
    verified: true, verificationBasis: 'recorded-local-build', installationRecordMatched: true, runningProcessVerified: false,
  });
  assert.throws(() => verify(localSha), { diagnosticCode: 'installation_record_required' });
});

test('original cloud build keeps its fixed pin and optional matching record', async () => {
  const verify = await identityRules();
  assert.deepEqual(verify(cloudSha), {
    verified: true, verificationBasis: 'cloud-artifact', installationRecordMatched: null, runningProcessVerified: false,
  });
  assert.deepEqual(verify(cloudSha, { ...installationRecord, recordedPublicBridgeSha256: cloudSha }, companionManifest), {
    verified: true, verificationBasis: 'cloud-artifact', installationRecordMatched: true, runningProcessVerified: false,
  });
  assert.throws(() => verify(cloudSha, installationRecord, companionManifest), { diagnosticCode: 'installation_record_invalid' });
});

for (const sha of ['0'.repeat(64), localSha.slice(0, -1) + 'd', cloudSha.toUpperCase(), 'ebacb5650965cdf7837e726b6690f400899861bbc6b39a423bb91c556e9babd5']) {
  test(`unapproved exact fingerprint ${sha.slice(0, 8)} cannot be approved by a self-written record`, async () => {
    const verify = await identityRules();
    assert.throws(() => verify(sha, { ...installationRecord, recordedPublicBridgeSha256: sha }, companionManifest), { diagnosticCode: 'package_mismatch' });
    assert.throws(() => verify(sha), { diagnosticCode: 'package_mismatch' });
  });
}

for (const [name, invalid] of [
  ['null', null], ['array', [installationRecord]], ['boolean', true], ['string', JSON.stringify(installationRecord)],
  ['missing source', { pluginVersion: '0.3.5', recordedPublicBridgeSha256: localSha }],
  ['wrong source', { ...installationRecord, sourceCommit: '0'.repeat(40) }],
  ['wrong version', { ...installationRecord, pluginVersion: '0.3.4' }],
  ['boolean version', { ...installationRecord, pluginVersion: true }],
  ['string boolean version', { ...installationRecord, pluginVersion: 'true' }],
  ['non-string hash', { ...installationRecord, recordedPublicBridgeSha256: false }],
  ['wrong hash', { ...installationRecord, recordedPublicBridgeSha256: cloudSha }],
  ['uppercase hash', { ...installationRecord, recordedPublicBridgeSha256: localSha.toUpperCase() }],
  ['extra key', { ...installationRecord, accept: true }],
  ['inherited fields', Object.create(installationRecord)],
  ['whitespace source', { ...installationRecord, sourceCommit: installationRecord.sourceCommit + ' ' }],
] as const) test(`installation record rejects ${name} without weakening the known-build policy`, async () => {
  const verify = await identityRules();
  assert.throws(() => verify(localSha, invalid, companionManifest), { diagnosticCode: 'installation_record_invalid' });
});

for (const [name, invalid] of [
  ['missing', undefined], ['null', null], ['array', []], ['boolean', true],
  ['wrong schema', { ...companionManifest, schemaVersion: 2 }],
  ['string schema', { ...companionManifest, schemaVersion: '1' }],
  ['wrong plugin', { ...companionManifest, pluginName: 'other' }],
  ['wrong version', { ...companionManifest, pluginVersion: '0.3.4' }],
  ['wrong track', { ...companionManifest, track: 'daily' }],
  ['missing field', { schemaVersion: 1, pluginName: 'siyuan-ai-collab', pluginVersion: '0.3.5' }],
] as const) test(`record-based verification rejects ${name} companion manifest for either known build`, async () => {
  const verify = await identityRules();
  for (const sha of [localSha, cloudSha]) assert.throws(() => verify(sha, { ...installationRecord, recordedPublicBridgeSha256: sha }, invalid), { diagnosticCode: 'companion_manifest_invalid' });
});
async function load() {
  let module: any;
  try { module = await import(pathToFileURL(target).href); } catch {}
  assert.equal(typeof module?.runDiagnostics, 'function', 'independent read-only diagnostic tool is not implemented');
  return { runDiagnostics: (options: unknown, dependencies: any = {}) => module.runDiagnostics(options, { loadBundle: async () => ({ createBridgeServer }), ...dependencies }) };
}
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'hermes-diagnostic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  const bundle = Buffer.from('synthetic package placeholder: only trusted test loader may bypass verification');
  await writeFile(join(root, 'scripts/bridge.mjs'), bundle);
  const bridgeTokenFile = join(root, 'bridge-token'), studioTokenFile = join(root, 'studio-token');
  await writeFile(bridgeTokenFile, cap); await writeFile(studioTokenFile, token);
  const options = { companionRoot: root, bridgeUrl: 'http://127.0.0.1:8782', bridgeTokenFile, studioUrl: 'http://127.0.0.1:8748', studioTokenFile };
  const unchanged = async () => {
    assert.deepEqual((await readdir(root)).sort(), ['bridge-token', 'scripts', 'studio-token']);
    assert.deepEqual(await readdir(join(root, 'scripts')), ['bridge.mjs']);
    assert.deepEqual(await readFile(join(root, 'scripts/bridge.mjs')), bundle);
    assert.equal(await readFile(bridgeTokenFile, 'utf8'), cap); assert.equal(await readFile(studioTokenFile, 'utf8'), token);
  };
  return { options, unchanged };
}
async function cli(options: Record<string, string>, extra: string[] = []) {
  const keys: Record<string, string> = { companionRoot: '--companion-root', bridgeUrl: '--bridge-url', bridgeTokenFile: '--bridge-token-file', studioUrl: '--studio-url', studioTokenFile: '--studio-token-file', installationRecord: '--installation-record' };
  let output;
  try { output = await execute(process.execPath, [target, ...Object.entries(options).flatMap(([key, value]) => [keys[key], value]), ...extra], { timeout: 2000 }); }
  catch (error: any) { output = { stdout: error.stdout, stderr: error.stderr }; }
  assert.equal(output.stderr, '');
  assert.equal(output.stdout.trim().split('\n').length, 1);
  return JSON.parse(output.stdout);
}

for (const kind of ['missing', 'directory', 'symlink', 'malformed', 'extra-key', 'string-boolean']) test(`CLI refuses ${kind} installation record before import, token reads, or HTTP`, async t => {
  const f = await fixture(t), path = join(f.options.companionRoot, 'installation-record.json');
  if (kind === 'directory') await mkdir(path);
  if (kind === 'symlink') await symlink(f.options.bridgeTokenFile, path);
  if (kind === 'malformed') await writeFile(path, `${token}{`);
  if (kind === 'extra-key') await writeFile(path, JSON.stringify({ ...installationRecord, token }));
  if (kind === 'string-boolean') await writeFile(path, JSON.stringify({ ...installationRecord, pluginVersion: 'true' }));
  await writeFile(join(f.options.companionRoot, 'scripts/bridge.mjs'), `throw new Error(${JSON.stringify(token)});`);
  const result = await cli({ ...f.options, installationRecord: path, bridgeTokenFile: join(f.options.companionRoot, 'missing-token') });
  assert.deepEqual(result, { status: 'refused', reason: 'installation_record_invalid' });
  safe(result, f.options.companionRoot);
});

for (const extra of [
  ['--expected-hash', localSha], ['--skip-verification', 'true'], ['--load-bundle', 'fake'],
  ['--installation-record', 'one', '--installation-record', 'two'], ['--installation-record'],
]) test(`CLI rejects unsupported or ambiguous trust arguments ${extra[0]}`, async t => {
  const f = await fixture(t), result = await cli(f.options, extra);
  assert.deepEqual(result, { status: 'refused', reason: 'invalid_arguments' });
  safe(result, f.options.companionRoot); await f.unchanged();
});

for (const count of [1, 2]) test(`CLI accepts only a single leading UTF-8 BOM in the public record (${count})`, async t => {
  const f = await fixture(t), path = join(f.options.companionRoot, 'installation-record.json');
  const contents = '\uFEFF'.repeat(count) + JSON.stringify(installationRecord);
  await writeFile(path, contents);
  await writeFile(join(f.options.companionRoot, 'companion-manifest.json'), JSON.stringify(companionManifest));
  const result = await cli({ ...f.options, installationRecord: path, bridgeTokenFile: join(f.options.companionRoot, 'missing-token') });
  assert.deepEqual(result, { status: 'refused', reason: count === 1 ? 'package_mismatch' : 'installation_record_invalid' });
  assert.equal(await readFile(path, 'utf8'), contents);
  safe(result, f.options.companionRoot);
});
function safe(result: unknown, root: string) {
  const output = JSON.stringify(result);
  for (const value of [...forbidden, root, 'http://', 'Error:', 'stack']) assert.equal(output.includes(value), false, `diagnostic exposed forbidden fixture content`);
}
function transport(index: unknown, canonical: unknown, calls: string[]) {
  return async (raw: URL | string, init: RequestInit) => {
    const url = new URL(raw); calls.push(url.pathname + url.search);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal); assert.equal(init.body, undefined);
    if (url.port === '8782') {
      if (url.pathname === '/health') { assert.equal(new Headers(init.headers).has('X-Siyuan-Collab-Token'), false); return resp({ ok: true, service: 'siyuan-ai-collab-bridge' }); }
      assert.equal(new Headers(init.headers).get('X-Siyuan-Collab-Token'), cap);
      assert.equal(url.pathname, '/connections');
      return resp({ data: [{ kind: 'studio', state: 'ready', title: forbidden[2], id: forbidden[0], profile: forbidden[1] }] });
    }
    assert.equal(url.port, '8748'); assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${token}`);
    return resp(url.pathname === '/api/studio/sessions' ? index : canonical);
  };
}

test('real Bridge route is called without listening and diagnosis returns two separate safe rounds', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [];
  const oldDiagnostic = process.env.SIYUAN_BRIDGE_DIAGNOSTICS;
  process.env.SIYUAN_BRIDGE_DIAGNOSTICS = '1';
  const printed: unknown[] = [], originalLog = console.log;
  console.log = (...values: unknown[]) => { printed.push(values); };
  let result;
  try { result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: transport({ sessions: [{ id: forbidden[0], profile: forbidden[1], title: forbidden[2] }] }, { sessions: [{ id: forbidden[0], messages: [{ content: forbidden[3] }] }] }, calls) }); }
  finally { console.log = originalLog; if (oldDiagnostic === undefined) delete process.env.SIYUAN_BRIDGE_DIAGNOSTICS; else process.env.SIYUAN_BRIDGE_DIAGNOSTICS = oldDiagnostic; }
  assert.deepEqual(printed, []);
  assert.equal(result.status, 'complete'); assert.equal(result.package.verified, true); assert.equal(result.package.runningProcessVerified, false);
  assert.equal(result.rounds.length, 2);
  for (const round of result.rounds) {
    assert.deepEqual(round.liveBridge.connections, [{ kind: 'studio', state: 'ready' }]);
    assert.equal(round.independentPackageProbe.state, 'ready'); assert.equal(round.independentPackageProbe.firstFailure, null);
    assert.equal(round.independentPackageProbe.checks.canonicalMissingProfilesKnown, true);
  }
  assert.deepEqual(calls, Array(2).fill(['/health', '/connections', '/api/studio/sessions', '/api/studio/sessions/hermes?offset=0&limit=1']).flat());
  safe(result, f.options.companionRoot); await f.unchanged();
});

for (const [body, firstFailure] of [
  [{ sessions: [{ id: 'synthetic-unknown-id' }] }, 'canonicalMissingProfilesKnown'],
  [{ sessions: [{ id: forbidden[0], profile: null }] }, 'canonicalExplicitProfilesValid'],
  [{ sessions: [{ id: forbidden[0] }], offset: null }, 'canonicalOffsetValid'],
  [{ sessions: [{ id: forbidden[0] }], hasMore: true, offset: 0, limit: 0 }, 'canonicalLimitValid'],
  [{ sessions: [{ id: forbidden[0], profile: 'synthetic-conflicting-profile' }] }, 'canonicalIndexProfilesConsistent'],
] as const) test(`historical field summary locates ${firstFailure} alongside the current Bridge state`, async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [];
  const result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: transport({ sessions: [{ id: forbidden[0], profile: 'default' }] }, body, calls) });
  for (const round of result.rounds) {
    // This fixture deliberately imports the current Bridge. Its partial-read
    // contract accepts unresolved rows, while the frozen 0.3.5 field summary
    // still records their missing ownership. Keep those assertions separate.
    assert.equal(round.independentPackageProbe.state, firstFailure === 'canonicalMissingProfilesKnown' ? 'ready' : 'incompatible'); assert.equal(round.independentPackageProbe.firstFailure, firstFailure);
    assert.equal(round.independentPackageProbe.checks[firstFailure], false);
  }
  safe(result, f.options.companionRoot); assert.equal(JSON.stringify(result).includes('synthetic-unknown-id'), false); await f.unchanged();
});

for (const unsafe of ['http://outside.example', 'http://user@127.0.0.1:8748', 'http://127.0.0.1:8748/path', 'http://localhost:8748', 'https://127.0.0.1:8748', 'http://127.0.0.1:8748?secret=1']) test(`untrusted configured URL is refused before credentials or requests`, async t => {
  const { runDiagnostics } = await load(), f = await fixture(t); let requests = 0;
  const result = await runDiagnostics({ ...f.options, studioUrl: unsafe, bridgeTokenFile: '/does-not-exist' }, { fetchImpl: async () => { requests++; throw Error(token); } });
  assert.equal(result.status, 'refused'); assert.equal(result.reason, 'invalid_arguments'); assert.equal(requests, 0); safe(result, f.options.companionRoot); await f.unchanged();
});

test('wrong bundle hash refuses before import and all network requests', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t); let requests = 0;
  await writeFile(join(f.options.companionRoot, 'scripts/bridge.mjs'), 'throw new Error("synthetic-private-body");');
  const result = await runDiagnostics(f.options, { loadBundle: undefined, fetchImpl: async () => { requests++; throw Error(token); } });
  assert.equal(result.status, 'refused'); assert.equal(result.reason, 'package_mismatch'); assert.equal(requests, 0); safe(result, f.options.companionRoot);
});

test('credential file failure is reported without filenames or stacks and without requests', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t); let requests = 0;
  const result = await runDiagnostics({ ...f.options, bridgeTokenFile: join(f.options.companionRoot, 'missing-private-token') }, { fetchImpl: async () => { requests++; throw Error(token); } });
  assert.equal(result.status, 'refused'); assert.equal(result.reason, 'credentials_unavailable'); assert.equal(requests, 0); safe(result, f.options.companionRoot); await f.unchanged();
});

for (const status of [401, 403, 302]) test(`Studio HTTP ${status} is summarized and never followed or consumed`, async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [];
  const base = transport({ sessions: [] }, { sessions: [] }, calls);
  const result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: async (url: URL, init: RequestInit) => {
    if (url.pathname.startsWith('/api/studio/')) { calls.push(url.pathname); assert.equal(init.redirect, 'manual'); return new Response(token, { status, headers: { Location: 'http://outside.example' } }); }
    return base(url, init);
  } });
  for (const round of result.rounds) assert.equal(round.independentPackageProbe.transport, status === 302 ? 'redirect_denied' : 'auth_failed');
  assert.equal(calls.filter(path => path.startsWith('/api/studio/')).length, 2);
  safe(result, f.options.companionRoot); await f.unchanged();
});

for (const phase of ['headers', 'body']) test(`complete read deadline handles stalled ${phase} ignoring abort`, async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [], base = transport({ sessions: [] }, { sessions: [] }, calls);
  const never = () => new Promise<any>(() => {});
  const started = performance.now();
  const result = await runDiagnostics(f.options, { timeoutMs: 30, fetchImpl: async (url: URL, init: RequestInit) => url.pathname.startsWith('/api/studio/') ? phase === 'headers' ? never() : { ok: true, status: 200, json: never } : base(url, init) });
  assert.ok(performance.now() - started < 1000);
  for (const round of result.rounds) assert.equal(round.independentPackageProbe.transport, 'timeout');
  safe(result, f.options.companionRoot); await f.unchanged();
});

test('import is inert and CLI errors emit exactly one safe JSON without stderr', async () => {
  await load();
  const inert = await execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(target).href)});`], { timeout: 2000 });
  assert.equal(inert.stdout, ''); assert.equal(inert.stderr, '');
  let output;
  try { output = await execute(process.execPath, [target, '--unknown', token], { timeout: 2000 }); }
  catch (error: any) { output = { stdout: error.stdout, stderr: error.stderr }; }
  assert.equal(output.stderr, ''); assert.equal(output.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(output.stdout), { status: 'refused', reason: 'invalid_arguments' });
});

for (const argument of ['constructor', 'toString', '--unknown']) test(`CLI rejects unknown inherited or ordinary parameter ${argument} before package or token reads`, async () => {
  let output;
  try {
    output = await execute(process.execPath, [target,
      '--companion-root', '/synthetic-does-not-exist/package', '--bridge-url', 'http://127.0.0.1:8782',
      '--bridge-token-file', '/synthetic-does-not-exist/bridge-token', '--studio-url', 'http://127.0.0.1:8748',
      '--studio-token-file', '/synthetic-does-not-exist/studio-token', argument, 'ignored'], { timeout: 2000 });
  } catch (error: any) { output = { stdout: error.stdout, stderr: error.stderr }; }
  assert.equal(output.stderr, ''); assert.equal(output.stdout.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(output.stdout), { status: 'refused', reason: 'invalid_arguments' });
});

test('actual loopback redirects never forward credentials on safe Bridge route reads', async t => {
  const { runDiagnostics } = await load(); const f = await fixture(t);
  let receivedExternal = 0; const observed: string[] = [];
  const targetServer = createServer((_req, res) => { receivedExternal++; res.end('{}'); });
  const server = createServer((req, res) => {
    observed.push(req.url!); res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, service: 'siyuan-ai-collab-bridge' }));
    if (req.url === '/connections') { assert.equal(req.headers['x-siyuan-collab-token'], cap); return res.end(JSON.stringify({ data: [{ kind: 'studio', state: 'ready' }] })); }
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.writeHead(302, { Location: `http://127.0.0.1:${(targetServer.address() as any).port}/outside` }); res.end();
  });
  for (const item of [targetServer, server]) { t.after(async () => { item.closeAllConnections(); await new Promise<void>(resolve => item.close(() => resolve())); }); await new Promise<void>(resolve => item.listen(0, '127.0.0.1', resolve)); }
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const result = await runDiagnostics({ ...f.options, bridgeUrl: url, studioUrl: url }, { timeoutMs: 1000 });
  assert.equal(result.status, 'complete');
  for (const round of result.rounds) assert.equal(round.independentPackageProbe.transport, 'redirect_denied');
  assert.equal(receivedExternal, 0); assert.deepEqual(observed, Array(2).fill(['/health', '/connections', '/api/studio/sessions']).flat());
  safe(result, f.options.companionRoot); await f.unchanged();
});

test('live Bridge changes are reported separately from the new independent package requests', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [], base = transport({ sessions: [] }, { sessions: [] }, calls);
  let connectionReads = 0;
  const result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: async (url: URL, init: RequestInit) => url.pathname === '/connections'
    ? resp({ data: [{ kind: 'studio', state: ++connectionReads === 1 ? 'incompatible' : 'ready' }] }) : base(url, init) });
  assert.deepEqual(result.rounds.map((round: any) => round.liveBridge.connections[0].state), ['incompatible', 'ready']);
  assert.deepEqual(result.rounds.map((round: any) => round.independentPackageProbe.state), ['ready', 'ready']);
  safe(result, f.options.companionRoot); await f.unchanged();
});

test('arbitrary live connection states never enter diagnostic output', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [], base = transport({ sessions: [] }, { sessions: [] }, calls);
  const result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: async (url: URL, init: RequestInit) => url.pathname === '/connections' ? resp({ data: [{ kind: 'studio', state: token }] }) : base(url, init) });
  for (const round of result.rounds) { assert.equal(round.liveBridge.status, 'invalid_payload'); assert.deepEqual(round.liveBridge.connections, []); }
  safe(result, f.options.companionRoot); await f.unchanged();
});

test('original JSON is consumed once and the real server is never listened or allowed to write stores', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [], base = transport({ sessions: [] }, { sessions: [] }, calls);
  let consumed = 0; const servers: any[] = [];
  const result = await runDiagnostics(f.options, {
    timeoutMs: 100,
    loadBundle: async () => ({ createBridgeServer: (options: any) => {
      assert.deepEqual(options.connections.connections, [{ id: 'studio-default', kind: 'studio', profile: 'default' }]);
      assert.ok(options.capability.length >= 64);
      const made = createBridgeServer(options); made.server.listen = () => assert.fail('diagnostic opened a listener'); servers.push(made.server); return made;
    } }),
    fetchImpl: async (url: URL, init: RequestInit) => { const result = await base(url, init), original = result.json.bind(result); result.json = async () => { consumed++; return original(); }; return result; },
  });
  assert.equal(consumed, 8); assert.equal(servers.length, 2); assert.ok(servers.every(server => !server.listening));
  assert.equal(result.status, 'complete'); await f.unchanged();
});

for (const path of ['/api/studio/sessions/rename', '/api/studio/sessions/hermes?offset=0&limit=200', 'http://outside.example/']) test('package request guard denies an unexpected read before forwarding', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [], base = transport({ sessions: [] }, { sessions: [] }, calls);
  const result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: base, loadBundle: async () => ({ createBridgeServer: (options: any) => ({ server: {
    emit: async (_event: string, _req: unknown, res: any) => {
      try { await options.fetchImpl(path, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(100), headers: { Authorization: `Bearer ${token}` } }); } catch {}
      res.end(JSON.stringify({ data: [{ state: 'incompatible' }] }));
    }, close() {},
  } }) }) });
  assert.equal(result.status, 'complete'); assert.deepEqual(calls, ['/health', '/connections', '/health', '/connections']);
  safe(result, f.options.companionRoot); await f.unchanged();
});

test('non-syntax body read failure retains original offline classification without revealing its error', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [], base = transport({ sessions: [] }, { sessions: [] }, calls);
  const result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: async (url: URL, init: RequestInit) => {
    const response = await base(url, init);
    if (url.pathname === '/api/studio/sessions') response.json = async () => { throw new Error(token); };
    return response;
  } });
  for (const round of result.rounds) {
    assert.equal(round.independentPackageProbe.state, 'offline');
    assert.equal(round.independentPackageProbe.transport, 'body_read_failed');
    assert.equal(round.independentPackageProbe.reads.index.httpStatus, 200);
    assert.equal(round.independentPackageProbe.reads.index.redirected, false);
  }
  safe(result, f.options.companionRoot); await f.unchanged();
});

for (const status of [200, 404, 405]) test(`HTTP ${status} is retained independently for live and packaged endpoint reads`, async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [], base = transport({ sessions: [] }, { sessions: [] }, calls);
  const result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: async (url: URL, init: RequestInit) => {
    if (url.pathname === '/connections' || url.pathname === '/api/studio/sessions/hermes') return resp(status === 200 ? url.pathname === '/connections' ? { data: [{ kind: 'studio', state: 'ready' }] } : { sessions: [] } : { privateError: token }, status);
    return base(url, init);
  } });
  for (const round of result.rounds) {
    assert.equal(round.liveBridge.healthRead.httpStatus, 200);
    assert.equal(round.liveBridge.connectionsRead.httpStatus, status);
    assert.equal(round.independentPackageProbe.reads.index.httpStatus, 200);
    assert.equal(round.independentPackageProbe.reads.canonical.httpStatus, status);
    assert.equal(round.independentPackageProbe.state, status === 200 ? 'ready' : 'incompatible');
  }
  safe(result, f.options.companionRoot); await f.unchanged();
});

for (const value of [{ profile: null }, {}]) test('profile type summary distinguishes explicit null from missing fields without values', async t => {
  const { runDiagnostics } = await load(), f = await fixture(t), calls: string[] = [];
  const result = await runDiagnostics(f.options, { timeoutMs: 100, fetchImpl: transport({ sessions: [{ id: forbidden[0], profile: forbidden[1] }] }, { sessions: [{ id: forbidden[0], ...value }] }, calls) });
  for (const round of result.rounds) {
    assert.deepEqual(round.independentPackageProbe.types.indexProfileTypes, ['string']);
    assert.deepEqual(round.independentPackageProbe.types.canonicalProfileTypes, ['profile' in value ? 'null' : 'missing']);
  }
  safe(result, f.options.companionRoot); await f.unchanged();
});
