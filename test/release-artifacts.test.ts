import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(project, '.cache');
const command = join(project, 'scripts/release-artifacts.mjs');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function git(root: string, args: string[], input?: string) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Public release fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: root, encoding: 'utf8', input, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}
async function fixture() {
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'release-fixture-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'dist'));
  const license = await readFile(join(project, 'LICENSE'));
  const pkg = { name: 'siyuan-ai-collab', version: '0.3.25', license: 'AGPL-3.0-only' };
  const plugin = { name: pkg.name, version: pkg.version, author: 'chings-yan', url: 'https://github.com/chings-yan/siyuan-ai-work' };
  const sources: Record<string, Uint8Array | string> = {
    '.gitignore': 'dist/\n.cache/\n.env\nprivate/\n',
    'README.md': '# Public fixture\n', 'LICENSE': license,
    'package.json': JSON.stringify(pkg), 'plugin.json': JSON.stringify(plugin),
    'src/example.ts': 'export const publicSource = true;\n',
  };
  for (const [path, bytes] of Object.entries(sources)) await writeFile(join(root, path), bytes);
  async function archive(name: string, entries: Record<string, Uint8Array | string>) {
    const zip = new JSZip();
    for (const [path, bytes] of Object.entries(entries)) zip.file(path, bytes, { createFolders: false });
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    await writeFile(join(root, 'dist', name), bytes);
    return { file: name, sha256: hash(bytes), files: Object.fromEntries(Object.entries(entries).map(([path, value]) => [path, hash(value)])) };
  }
  const frontend = await archive('package.zip', { 'LICENSE': license, 'README.md': sources['README.md'], 'index.js': 'module.exports = {};\n', 'plugin.json': JSON.stringify(plugin) });
  const companion = await archive('bridge-companion.zip', {
    'LICENSE': license, 'README.md': '# Public companion\n',
    'THIRD-PARTY-NOTICES.md': 'Project license: AGPL-3.0-only. Third-party notices are retained.\n',
    'companion-manifest.json': JSON.stringify({ schemaVersion: 1, pluginName: pkg.name, pluginVersion: pkg.version, track: 'shared-service' }),
  });
  await writeFile(join(root, 'dist/package-manifest.json'), JSON.stringify({ name: pkg.name, version: pkg.version, track: 'shared-service', plugin: frontend, companion }));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['add', '--', ...Object.keys(sources)]);
  git(root, ['commit', '-m', 'Public source fixture']);
  await writeFile(join(root, '.env'), 'PRIVATE_UNTRACKED_FIXTURE=not-a-real-secret\n');
  await mkdir(join(root, 'private'));
  await writeFile(join(root, 'private/state.json'), '{"synthetic":true}');
  return { root, sources, commit: git(root, ['rev-parse', 'HEAD']) };
}
function run(root: string) {
  return spawnSync(process.execPath, [command, root], { cwd: project, encoding: 'utf8', timeout: 20000, windowsHide: true });
}
async function cleanup(root: string) {
  assert.match(relative(cache, root), /^release-fixture-[^\\/]+$/);
  await rm(root, { recursive: true, force: true });
}
async function rejects(root: string, expected: RegExp) {
  const result = run(root);
  assert.notEqual(result.status, 0, 'Unsafe inputs must stop source release generation');
  assert.match(result.stderr, expected);
  await assert.rejects(readFile(join(root, 'dist/siyuan-ai-collab-0.3.25-source.zip')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'dist/source-manifest.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'dist/SHA256SUMS')), { code: 'ENOENT' });
}

test('release artifacts contain only exact tracked source and six verifiable release files', async () => {
  const { root, sources, commit } = await fixture();
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const zip = await JSZip.loadAsync(await readFile(join(root, 'dist/siyuan-ai-collab-0.3.25-source.zip')), { checkCRC32: true });
    assert.deepEqual(Object.keys(zip.files).sort(), Object.keys(sources).sort());
    for (const [path, bytes] of Object.entries(sources)) assert.deepEqual(await zip.file(path)!.async('nodebuffer'), Buffer.from(bytes));
    const manifest = JSON.parse(await readFile(join(root, 'dist/source-manifest.json'), 'utf8'));
    assert.equal(manifest.commit, commit);
    assert.equal(manifest.version, '0.3.25');
    assert.equal(manifest.license, 'AGPL-3.0-only');
    assert.deepEqual(manifest.files.map((entry: any) => entry.path).sort(), Object.keys(sources).sort());
    for (const entry of manifest.files) { assert.equal(entry.sha256, hash(sources[entry.path])); assert.equal(entry.bytes, Buffer.byteLength(sources[entry.path])); }
    const sums = (await readFile(join(root, 'dist/SHA256SUMS'), 'utf8')).trim().split('\n');
    assert.equal(sums.length, 5);
    const names = [];
    for (const line of sums) { const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+)$/.exec(line); assert.ok(match); names.push(match[2]); assert.equal(match[1], hash(await readFile(join(root, 'dist', match[2])))); }
    assert.deepEqual(names.sort(), ['bridge-companion.zip', 'package-manifest.json', 'package.zip', 'siyuan-ai-collab-0.3.25-source.zip', 'source-manifest.json'].sort());
  } finally { await cleanup(root); }
});
test('release artifacts reject a mistakenly tracked private environment file', async () => {
  const { root } = await fixture();
  try { git(root, ['add', '--force', '.env']); git(root, ['commit', '-m', 'Synthetic unsafe tracked fixture']); await rejects(root, /private|public source/i); }
  finally { await cleanup(root); }
});
test('release artifacts reject source bytes changed after the public commit', async () => {
  const { root } = await fixture();
  try { await writeFile(join(root, 'src/example.ts'), 'export const uncommitted = true;\n'); await rejects(root, /uncommitted|tracked.*changed/i); }
  finally { await cleanup(root); }
});
test('release artifacts reject mismatched plugin and package versions', async () => {
  const { root } = await fixture();
  try { const plugin = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8')); plugin.version = '0.3.24'; await writeFile(join(root, 'plugin.json'), JSON.stringify(plugin)); git(root, ['add', 'plugin.json']); git(root, ['commit', '-m', 'Synthetic mismatched version']); await rejects(root, /identity|version/i); }
  finally { await cleanup(root); }
});
test('release artifacts reject an incomplete project license', async () => {
  const { root } = await fixture();
  try { await writeFile(join(root, 'LICENSE'), 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n'); git(root, ['add', 'LICENSE']); git(root, ['commit', '-m', 'Synthetic incomplete license']); await rejects(root, /license/i); }
  finally { await cleanup(root); }
});
test('release artifacts reject a ZIP altered after package manifest creation', async () => {
  const { root } = await fixture();
  try { await writeFile(join(root, 'dist/package.zip'), 'not-the-verified-package'); await rejects(root, /checksum|digest|SHA/i); }
  finally { await cleanup(root); }
});
test('release artifacts reject a tracked link mode before reading its target', async () => {
  const { root } = await fixture();
  try { const sha = git(root, ['hash-object', '-w', '--stdin'], 'outside-target'); git(root, ['update-index', '--add', '--cacheinfo', `120000,${sha},src/link.ts`]); await rejects(root, /regular|mode|link/i); }
  finally { await cleanup(root); }
});
