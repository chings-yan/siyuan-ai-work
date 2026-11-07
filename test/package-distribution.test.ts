import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';

const execute = promisify(execFile);
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(project, '.cache');
const windowsEntries = ['prepare-bridge.cmd', 'start-bridge.cmd'];
const runtimeSources = [
  'bridge.mjs', 'bridge-supervisor.mjs', 'pair.mjs', 'bridge-config.mjs', 'bridge-metadata.mjs', 'studio-client.mjs',
  'ekko-routes.mjs', 'ekko-auth.mjs', 'ekko-private-file.mjs', 'ekko-room-client.mjs',
  'hermes-session-runs.mjs', 'hermes-session-run-record.mjs', 'hermes-history-snapshot.mjs',
];
async function fixture() {
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'package-fixture-'));
  for (const dir of ['scripts', 'docs', 'dist', 'backups', 'private']) await mkdir(join(root, dir));
  await copyFile(join(project, 'scripts/package.mjs'), join(root, 'scripts/package.mjs'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'siyuan-ai-collab', version: '0.2.17', type: 'module' }));
  await writeFile(join(root, 'plugin.json'), JSON.stringify({ name: 'siyuan-ai-collab', version: '0.2.17' }));
  await writeFile(join(root, 'README.md'), '# Public installation guide');
  await writeFile(join(root, 'dist/index.js'), 'module.exports = class Plugin {};');
  for (const entry of ['bridge.mjs', 'bridge-supervisor.mjs', 'pair.mjs']) {
    await writeFile(join(root, 'scripts', entry), 'export const publicEntry = true;');
  }
  for (const entry of windowsEntries) {
    await writeFile(join(root, 'scripts', entry), `@echo off\r\nrem Public ${entry} fixture\r\nexit /b 0\r\n`);
  }
  await writeFile(join(root, 'scripts/.env.example'), 'SIYUAN_BRIDGE_PORT=8782\n');
  await writeFile(join(root, 'docs/BRIDGE-SETUP.md'), '# Optional AI connection');
  for (const path of ['.env', 'bridge.local.json', 'private/bridge-token', 'backups/settings']) {
    await writeFile(join(root, path), 'PRIVATE_FIXTURE_MUST_NEVER_SHIP');
  }
  return root;
}
async function cleanup(root: string) {
  const rel = relative(cache, resolve(root));
  assert.match(rel, /^package-fixture-[^\\/]+$/);
  await rm(root, { recursive: true, force: true });
}

async function assertCompanionIdentity(root: string, plugin: JSZip, companion: JSZip, track: 'studio-compatible' | 'shared-service') {
  const pluginInfo = JSON.parse(await plugin.file('plugin.json')!.async('string'));
  const publicFile = companion.file('companion-manifest.json');
  assert.ok(publicFile, 'Companion must identify its plugin version and release track inside the ZIP');
  const identity = JSON.parse(await publicFile.async('string'));
  assert.deepEqual(identity, { schemaVersion: 1, pluginName: pluginInfo.name, pluginVersion: pluginInfo.version, track });
  const readme = await companion.file('README.md')!.async('string');
  const separator = readme.indexOf('\n---\n');
  assert.ok(separator > 0 && separator < 300, 'Identity must be visible at the beginning of the companion guide');
  const opening = readme.slice(0, separator);
  assert.ok(opening.includes(pluginInfo.name));
  assert.ok(opening.includes(pluginInfo.version));
  assert.ok(opening.includes(track));
  assert.ok(readme.endsWith(await readFile(join(root, 'docs/BRIDGE-SETUP.md'), 'utf8')));
  const outside = JSON.parse(await readFile(join(root, 'dist/package-manifest.json'), 'utf8'));
  assert.equal(identity.pluginName, outside.name);
  assert.equal(identity.pluginVersion, outside.version);
  assert.equal(identity.track, outside.track);
  for (const name of ['companion-manifest.json', 'README.md']) {
    assert.equal(outside.companion.files[name], createHash('sha256').update(await companion.file(name)!.async('nodebuffer')).digest('hex'));
  }
  assert.equal(outside.companion.sha256, createHash('sha256').update(await readFile(join(root, 'dist/bridge-companion.zip'))).digest('hex'));
  const entries = Object.keys(companion.files).filter(name => /^scripts\/[^/]+\.mjs$/.test(name)).sort();
  assert.deepEqual(entries, track === 'shared-service'
    ? ['scripts/bridge-supervisor.mjs', 'scripts/bridge.mjs', 'scripts/hermes-serve-launcher.mjs', 'scripts/pair.mjs']
    : ['scripts/bridge-supervisor.mjs', 'scripts/bridge.mjs', 'scripts/pair.mjs']);
  assert.equal(Boolean(companion.file('scripts/hermes-serve.env.example')), track === 'shared-service');
  return identity;
}

test('distribution contains standard front-end ZIP and runnable companion, without local state', async () => {
  const root = await fixture();
  try {
    await execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 });
    const plugin = await JSZip.loadAsync(await readFile(join(root, 'dist/package.zip')));
    assert.deepEqual(Object.keys(plugin.files).filter(name => !plugin.files[name].dir).sort(), ['README.md', 'index.js', 'plugin.json']);
    assert.equal(JSON.parse(await plugin.file('plugin.json')!.async('string')).version, '0.2.17');
    const companion = await JSZip.loadAsync(await readFile(join(root, 'dist/bridge-companion.zip')));
    assert.deepEqual(Object.keys(companion.files).sort(), [
      'README.md', 'THIRD-PARTY-NOTICES.md', 'companion-manifest.json',
      'prepare-bridge.cmd', 'start-bridge.cmd', 'scripts/.env.example',
      'scripts/bridge.mjs', 'scripts/bridge-supervisor.mjs', 'scripts/pair.mjs',
    ].sort());
    await assertCompanionIdentity(root, plugin, companion, 'studio-compatible');
    for (const name of ['README.md', 'scripts/.env.example', 'scripts/bridge.mjs', 'scripts/bridge-supervisor.mjs', 'scripts/pair.mjs']) {
      assert.ok(companion.file(name), `Missing companion entry ${name}`);
    }
    for (const zip of [plugin, companion]) for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      assert.doesNotMatch(entry.name, /(^|\/)(backups|private|bridge\.local\.json|settings|bridge-token)(\/|$)/);
      assert.doesNotMatch(await entry.async('string'), /PRIVATE_FIXTURE_MUST_NEVER_SHIP/);
    }
    const manifest = JSON.parse(await readFile(join(root, 'dist/package-manifest.json'), 'utf8'));
    assert.equal(manifest.version, '0.2.17');
    for (const [info, zip] of [[manifest.plugin, plugin], [manifest.companion, companion]] as const) {
      const bytes = await readFile(join(root, 'dist', info.file));
      assert.equal(info.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.deepEqual(Object.keys(info.files).sort(), Object.keys(zip.files).sort());
      for (const [name, checksum] of Object.entries(info.files)) {
        assert.equal(checksum, createHash('sha256').update(await zip.file(name)!.async('nodebuffer')).digest('hex'));
      }
    }
    await execute(process.execPath, [join(root, 'dist/bridge-companion/scripts/pair.mjs')], { cwd: root, timeout: 5000 });
  } finally { await cleanup(root); }
});

test('extracted actual companion imports without side effects and serves controlled health/auth checks without installed dependencies', async () => {
  const root = await fixture();
  try {
    for (const name of ['package.json', 'plugin.json']) await copyFile(join(project, name), join(root, name));
    await copyFile(join(project, 'LICENSE'), join(root, 'LICENSE'));
    for (const name of runtimeSources) await copyFile(join(project, 'scripts', name), join(root, 'scripts', name));
    for (const entry of windowsEntries) await copyFile(join(project, 'scripts', entry), join(root, 'scripts', entry));
    for (const name of ['bridge-chat-store.mjs', 'hermes-connections.mjs', 'hermes-gateway-client.mjs']) {
      try { await copyFile(join(project, 'scripts', name), join(root, 'scripts', name)); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
    let withLauncher = false;
    try { withLauncher = (await stat(join(project, 'scripts/hermes-serve-launcher.mjs'))).isFile(); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (withLauncher) {
      for (const name of ['hermes-serve-launcher.mjs', 'hermes-serve.env.example']) {
        await copyFile(join(project, 'scripts', name), join(root, 'scripts', name));
      }
    }
    await execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 });
    const companion = await JSZip.loadAsync(await readFile(join(root, 'dist/bridge-companion.zip')), { checkCRC32: true });
    assert.deepEqual(Object.keys(companion.files).filter(name => name.endsWith('.cmd')).sort(), windowsEntries);
    for (const entry of windowsEntries) {
      assert.deepEqual(await companion.file(entry)!.async('nodebuffer'), await readFile(join(project, 'scripts', entry)));
    }
    const plugin = await JSZip.loadAsync(await readFile(join(root, 'dist/package.zip')));
    const identity = await assertCompanionIdentity(root, plugin, companion, withLauncher ? 'shared-service' : 'studio-compatible');
    const notices = await companion.file('THIRD-PARTY-NOTICES.md')!.async('string');
    assert.match(notices, /socket\.io-client 4\./);
    assert.match(notices, /engine\.io-client 6\./);
    for (const prefix of ['LICENSES/socket.io-client-', 'LICENSES/engine.io-client-', 'LICENSES/ws-']) {
      const names = Object.keys(companion.files).filter(name => name.startsWith(prefix));
      assert.ok(names.length, `Missing bundled dependency license ${prefix}; archive entries: ${Object.keys(companion.files).join(', ')}`);
      for (const name of names) assert.match(await companion.file(name)!.async('string'), /Copyright|Permission|Redistribution/i);
    }
    const extracted = join(root, 'extracted');
    for (const entry of Object.values(companion.files)) {
      assert.ok(!entry.name.startsWith('/') && !entry.name.includes('\\') && !entry.name.split('/').includes('..'));
      if (entry.dir) continue;
      const target = join(extracted, entry.name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await entry.async('nodebuffer'));
    }
    assert.deepEqual(JSON.parse(await readFile(join(extracted, 'companion-manifest.json'), 'utf8')), identity);
    await writeFile(join(extracted, 'companion-manifest.json'), JSON.stringify({...identity,pluginVersion:'99.88.77'}));
    assert.equal(await readFile(join(extracted, 'README.md'), 'utf8'), await companion.file('README.md')!.async('string'));
    const state = join(extracted, 'private');
    await mkdir(state);
    await writeFile(join(state, 'settings-sentinel'), 'unchanged isolated settings');
    const smoke = join(extracted, 'runtime-smoke.mjs');
    await writeFile(smoke, String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import cp from 'node:child_process';
import http from 'node:http';
import Module, { builtinModules, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const state = join(root, 'private');
const sourceFiles = new Set(['bridge.mjs', 'bridge-supervisor.mjs', 'pair.mjs', 'hermes-serve-launcher.mjs'].map(name => join(root, 'scripts', name)));
let importing = true, allowedPort;
const blocked = () => { throw new Error('Unexpected upstream network or child-process operation'); };
globalThis.fetch = blocked;
globalThis.WebSocket = class { constructor() { blocked(); } };
const load = Module._load;
Module._load = function(specifier, ...args) {
  if (!builtinModules.includes(specifier) && !builtinModules.includes(specifier.replace(/^node:/, ''))) throw new Error('External installed dependency is unavailable in companion smoke');
  return load.call(this, specifier, ...args);
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = blocked;
for (const api of [dns, dnsPromises]) for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) api[name] = blocked;
dns.lookup = (host, options, callback) => {
  assert.equal(host, '127.0.0.1');
  queueMicrotask(() => (typeof options === 'function' ? options : callback)(null, '127.0.0.1', 4));
};
dnsPromises.lookup = async host => { assert.equal(host, '127.0.0.1'); return { address: '127.0.0.1', family: 4 }; };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  assert.equal(importing, false, 'Import attempted a network connection');
  assert.equal(options?.host, '127.0.0.1', 'Only the isolated test server may be contacted');
  assert.equal(Number(options?.port), allowedPort, 'Unexpected upstream port');
  return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  assert.equal(importing, false, 'Import started a listener');
  assert.equal(args[0]?.host, '127.0.0.1');
  assert.equal(args[0]?.port, 0);
  return listen.apply(this, args);
};
// Imports may neither read configuration nor create or change local state.
for (const api of [fs, fsp]) {
  for (const name of ['readFile', 'readFileSync', 'existsSync', 'stat', 'statSync', 'lstat', 'lstatSync',
    'readdir', 'readdirSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
    'mkdir', 'mkdirSync', 'open', 'openSync', 'unlink', 'unlinkSync', 'rename', 'renameSync',
    'rm', 'rmSync', 'createWriteStream', 'createReadStream']) {
    if (typeof api[name] !== 'function') continue;
    const original = api[name];
    api[name] = function(path, ...args) {
      const target = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
      // Node's module loader reads these exact extracted code files through fs.openSync.
      const sourceRead = sourceFiles.has(target) && ['readFile', 'readFileSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'open', 'openSync'].includes(name);
      if (importing) {
        assert.ok(sourceRead, 'Import read configuration or changed state via ' + name);
        if (name === 'open' || name === 'openSync') assert.equal(args[0], 'r');
      }
      const rel = relative(root, target);
      assert.ok(!rel.startsWith('..') && !isAbsolute(rel), 'Read/write escaped the extracted fixture');
      return original.call(this, path, ...args);
    };
  }
}
syncBuiltinESMExports();
const bridge = await import('./scripts/bridge.mjs');
const supervisor = await import('./scripts/bridge-supervisor.mjs');
const pair = await import('./scripts/pair.mjs');
if (process.env.TEST_SERVE_LAUNCHER === '1') {
  const launcher = await import('./scripts/hermes-serve-launcher.mjs');
  assert.equal(typeof launcher.launchHermesServe, 'function');
}
assert.equal(typeof bridge.createBridgeServer, 'function');
assert.equal(typeof supervisor.runSupervisor, 'function');
assert.equal(typeof pair.setupBridgeToken, 'function');
importing = false;
const { server } = bridge.createBridgeServer({
  capability: 'f'.repeat(64), fetchImpl: blocked, studioRun: blocked, tokenProvider: () => '',
  studioToken: '', hermesBase: 'http://127.0.0.1:1', studioBase: 'http://127.0.0.1:1',
  bindingsFile: join(state, 'bindings.json'), bindingsV2File: join(state, 'bindings-v2.json'),
  connections: { defaultConnectionId: 'none', connections: [] }, gatewayFactory: blocked,
  ekko: { authStore: { read: async () => null }, pendingDirectory: join(state, 'pending'), socketFactory: blocked },
});

await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
allowedPort = server.address().port;
const request = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: allowedPort, path, headers, agent: false }, res => {
    let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  });
  req.on('error', reject); req.end();
});
try {
  assert.deepEqual(await request('/health'), { status: 200, body: { ok: true, service: 'siyuan-ai-collab-bridge' } });
  for(const path of ['/sessions','/connections']) {
    const unauthorized = await request(path);
    assert.equal(unauthorized.status, 401); assert.equal(unauthorized.body.error.code, 'unauthorized');
    assert.equal(unauthorized.body.meta, undefined);
    const rejectedOrigin = await request(path, { origin: 'https://untrusted.example', 'X-Siyuan-Collab-Token': 'f'.repeat(64) });
    assert.equal(rejectedOrigin.status, 403); assert.equal(rejectedOrigin.body.error.code, 'origin_denied');
    assert.equal(rejectedOrigin.body.meta, undefined);
  }
  assert.deepEqual(await request('/connections', { 'X-Siyuan-Collab-Token': 'f'.repeat(64) }), {status:200,body:{data:[],meta:{
    schemaVersion:1,bridgeVersion:process.env.TEST_BUILD_VERSION,capabilities:['hermes-connection-inspection-v1','ekko-authorization-record-v1','hermes-shared-session-v1','hermes-history-snapshot-v1'],
  }}});
  assert.deepEqual(await request('/ekko/connection', { 'X-Siyuan-Collab-Token': 'f'.repeat(64) }), { status: 200, body: { connection: null } });
  assert.equal(await fsp.readFile(join(state, 'settings-sentinel'), 'utf8'), 'unchanged isolated settings');
  assert.deepEqual(await fsp.readdir(state), ['settings-sentinel']);
  console.log('companion runtime: safe imports, health, authorization and isolated state verified');
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
`);
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      HOME: state, USERPROFILE: state, APPDATA: state, LOCALAPPDATA: state, HERMES_HOME: state,
      SIYUAN_BRIDGE_PROJECT_ROOT: extracted, SIYUAN_BRIDGE_DATA_DIR: state,
      HERMES_STUDIO_TOKEN_FILE: join(state, 'studio-token'), TEST_SERVE_LAUNCHER: withLauncher ? '1' : '0',
      TEST_BUILD_VERSION: identity.pluginVersion, __SAC_BRIDGE_VERSION__: '77.66.55',
    };
    const result = await execute(process.execPath, [smoke], { cwd: extracted, env, windowsHide: true, timeout: 10000 });
    assert.match(result.stdout, /companion runtime: safe imports, health, authorization and isolated state verified/);
    assert.equal(result.stderr, '');
  } finally { await cleanup(root); }
});

test('source metadata imports without file or listener side effects and reports an unknown build', async () => {
  const source=join(project,'scripts/bridge-metadata.mjs');
  assert.ok(await stat(source).catch(()=>null),'Source metadata module must exist');
  const result=await execute(process.execPath,['--input-type=module','-e',String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
const source=process.argv[1];
const blocked=()=>assert.fail('Metadata import attempted filesystem or network side effects');
for(const api of [fs,fsp])for(const name of ['readFile','readFileSync','writeFile','writeFileSync','appendFile','appendFileSync',
  'open','openSync','stat','statSync','lstat','lstatSync','existsSync','mkdir','mkdirSync','readdir','readdirSync',
  'rm','rmSync','unlink','unlinkSync','rename','renameSync','createReadStream','createWriteStream']) {
  if(typeof api[name]!=='function')continue;
  const original=api[name];
  api[name]=function(path,...args) {
    const target=path instanceof URL?fileURLToPath(path):String(path);
    if(target===source && ['readFile','readFileSync','open','openSync','stat','statSync'].includes(name)) {
      if(name==='open'||name==='openSync')assert.equal(args[0],'r');
      return original.call(this,path,...args);
    }
    return blocked();
  };
}
net.Server.prototype.listen=blocked;net.Socket.prototype.connect=blocked;globalThis.fetch=blocked;
syncBuiltinESMExports();
const {bridgeMetadata}=await import(source);
const expected={schemaVersion:1,bridgeVersion:null,capabilities:['hermes-connection-inspection-v1','ekko-authorization-record-v1','hermes-shared-session-v1','hermes-history-snapshot-v1']};
assert.deepEqual(bridgeMetadata(),expected);
const changed=bridgeMetadata();changed.capabilities.push('untrusted');changed.bridgeVersion='77.66.55';
assert.deepEqual(bridgeMetadata(),expected);
` ,source],{cwd:project,timeout:5000,env:{PATH:process.env.PATH,__SAC_BRIDGE_VERSION__:'77.66.55',npm_package_version:'88.77.66'}});
  assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

test('packaging rejects a symlinked output and preserves the existing target', async () => {
  const root = await fixture();
  try {
    const target = join(root, 'outside');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'preserve');
    await symlink(target, join(root, 'dist/siyuan-ai-collab'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 }));
    assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'preserve');
  } finally { await cleanup(root); }
});

test('companion includes the optional Serve launcher and example only when supplied', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'scripts/hermes-serve-launcher.mjs'), 'export const publicLauncher = true;');
    await writeFile(join(root, 'scripts/hermes-serve.env.example'), 'HERMES_SERVE_COMMAND=\n');
    await execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 });
    const companion = await JSZip.loadAsync(await readFile(join(root, 'dist/bridge-companion.zip')));
    assert.ok(companion.file('scripts/hermes-serve-launcher.mjs'), 'Missing optional Serve launcher');
    assert.equal(await companion.file('scripts/hermes-serve.env.example')?.async('string'), 'HERMES_SERVE_COMMAND=\n');
    await assertCompanionIdentity(root, await JSZip.loadAsync(await readFile(join(root, 'dist/package.zip'))), companion, 'shared-service');
    const { unlink } = await import('node:fs/promises');
    await unlink(join(root, 'scripts/hermes-serve-launcher.mjs'));
    await unlink(join(root, 'scripts/hermes-serve.env.example'));
    await execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 });
    const without = await JSZip.loadAsync(await readFile(join(root, 'dist/bridge-companion.zip')));
    assert.equal(without.file('scripts/hermes-serve-launcher.mjs'), null);
    assert.equal(without.file('scripts/hermes-serve.env.example'), null);
    await assertCompanionIdentity(root, await JSZip.loadAsync(await readFile(join(root, 'dist/package.zip'))), without, 'studio-compatible');
  } finally { await cleanup(root); }
});

test('standalone companion identifies both release tracks and the matching plugin version', async () => {
  const root = await fixture();
  try {
    for (const scenario of [
      { version: '0.2.17', track: 'studio-compatible' as const, serve: false },
      { version: '0.3.2', track: 'shared-service' as const, serve: true },
    ]) {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'siyuan-ai-collab', version: scenario.version, type: 'module' }));
      await writeFile(join(root, 'plugin.json'), JSON.stringify({ name: 'siyuan-ai-collab', version: scenario.version }));
      if (scenario.serve) {
        await writeFile(join(root, 'scripts/hermes-serve-launcher.mjs'), 'export const publicLauncher = true;');
        await writeFile(join(root, 'scripts/hermes-serve.env.example'), 'HERMES_SERVE_COMMAND=\n');
      }
      await execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 });
      const plugin = await JSZip.loadAsync(await readFile(join(root, 'dist/package.zip')));
      const companion = await JSZip.loadAsync(await readFile(join(root, 'dist/bridge-companion.zip')));
      await assertCompanionIdentity(root, plugin, companion, scenario.track);
    }
  } finally { await cleanup(root); }
});

for (const entry of windowsEntries) {
  test(`distribution preserves Windows source bytes at ZIP root for ${entry}`, async () => {
    const root = await fixture();
    try {
      await execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 });
      const companion = await JSZip.loadAsync(await readFile(join(root, 'dist/bridge-companion.zip')), { checkCRC32: true });
      const wrapper = companion.file(entry);
      assert.ok(wrapper, `Missing root Windows entry ${entry}`);
      assert.deepEqual(await wrapper.async('nodebuffer'), await readFile(join(root, 'scripts', entry)));
      assert.equal(companion.file(`scripts/${entry}`), null);
    } finally { await cleanup(root); }
  });
}

for (const entry of windowsEntries) for (const kind of ['missing', 'symlink', 'directory']) {
  test(`packaging rejects ${kind} Windows entry source ${entry}`, async () => {
    const root = await fixture();
    try {
      const source = join(root, 'scripts', entry);
      await rm(source);
      if (kind === 'symlink') {
        const target = join(root, 'public-wrapper-target.cmd');
        await writeFile(target, '@echo off\r\nexit /b 0\r\n');
        await symlink(target, source, 'file');
      } else if (kind === 'directory') await mkdir(source);
      await assert.rejects(
        execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 }),
        (error: any) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, /Windows entry must be a regular public source file/);
          return true;
        },
      );
      if (kind === 'missing') await assert.rejects(readFile(source), { code: 'ENOENT' });
    } finally { await cleanup(root); }
  });
}

test('declared AGPL project license is preserved in both distribution archives', async () => {
  const root = await fixture();
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    pkg.license = 'AGPL-3.0-only';
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    const license = await readFile(join(project, 'LICENSE'));
    await writeFile(join(root, 'LICENSE'), license);
    await execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 });
    const manifest = JSON.parse(await readFile(join(root, 'dist/package-manifest.json'), 'utf8'));
    for (const [archive, entry] of [['package.zip', manifest.plugin], ['bridge-companion.zip', manifest.companion]] as const) {
      const zip = await JSZip.loadAsync(await readFile(join(root, 'dist', archive)), { checkCRC32: true });
      const member = zip.file('LICENSE');
      assert.ok(member, `Missing project LICENSE in ${archive}`);
      assert.deepEqual(await member.async('nodebuffer'), license);
      assert.equal(entry.files.LICENSE, createHash('sha256').update(license).digest('hex'));
      assert.doesNotMatch(Object.keys(zip.files).join('|'), /private|backups|settings|bridge-token/);
    }
    const companion = await JSZip.loadAsync(await readFile(join(root, 'dist/bridge-companion.zip')));
    assert.match(await companion.file('THIRD-PARTY-NOTICES.md')!.async('string'), /Project license: AGPL-3\.0-only/);
  } finally { await cleanup(root); }
});

for (const kind of ['missing', 'empty', 'directory', 'symlink', 'wrong-content', 'wrong-declaration', 'truncated', 'altered-body']) {
  test(`declared project license rejects ${kind} source before creating archives`, async () => {
    const root = await fixture();
    try {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      pkg.license = kind === 'wrong-declaration' ? 'MIT' : 'AGPL-3.0-only';
      await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
      const path = join(root, 'LICENSE');
      if (kind === 'empty') await writeFile(path, '  \n');
      else if (kind === 'directory') await mkdir(path);
      else if (kind === 'symlink') {
        const target = join(root, 'license-link-target');
        await mkdir(target);
        await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      } else if (kind === 'wrong-content') await writeFile(path, 'MIT License\nWrong license fixture.\n');
      else if (kind === 'wrong-declaration') await copyFile(join(project, 'LICENSE'), path);
      else if (kind === 'truncated') await writeFile(path, 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\nEND OF TERMS AND CONDITIONS\n');
      else if (kind === 'altered-body') {
        const original = await readFile(join(project, 'LICENSE'), 'utf8');
        const changed = original.replace('freedom', 'restriction');
        assert.notEqual(changed, original, 'fixture must really alter license body');
        await writeFile(path, changed);
      }
      await assert.rejects(execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 }),
        (error: any) => { assert.equal(error.code, 1); assert.match(error.stderr, /Project license/); return true; });
      await assert.rejects(readFile(join(root, 'dist/package.zip')), { code: 'ENOENT' });
      await assert.rejects(readFile(join(root, 'dist/bridge-companion.zip')), { code: 'ENOENT' });
    } finally { await cleanup(root); }
  });
}

test('declared AGPL project license preserves complete CRLF source bytes in both archives', async () => {
  const root = await fixture();
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    pkg.license = 'AGPL-3.0-only';
    await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
    const license = Buffer.from((await readFile(join(project, 'LICENSE'), 'utf8')).replace(/\r?\n/g, '\r\n'));
    await writeFile(join(root, 'LICENSE'), license);
    await execute(process.execPath, [join(root, 'scripts/package.mjs')], { cwd: root, timeout: 20000 });
    for (const name of ['package.zip', 'bridge-companion.zip']) {
      const zip = await JSZip.loadAsync(await readFile(join(root, 'dist', name)), { checkCRC32: true });
      assert.deepEqual(await zip.file('LICENSE')!.async('nodebuffer'), license);
    }
  } finally { await cleanup(root); }
});
