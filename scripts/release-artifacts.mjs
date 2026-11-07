import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { frontendPackageFiles, readProjectLicense } from './package.mjs';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
const publicRoots = new Set([
  '.gitignore', 'README.md', 'LICENSE', 'CHANGELOG.md', 'RELEASE.md',
  'package.json', 'package-lock.json', 'plugin.json', 'tsconfig.json',
  'icon.png', 'assets/icon.svg', 'docs/BRIDGE-SETUP.md',
  '.github/workflows/publish-0.3.25.yml', '.github/workflows/publish-0.3.26.yml',
  '.github/workflows/publish-0.3.27.yml',
  '.github/workflows/refresh-release-copy-0.3.27.yml',
]);
function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !/[\\\u0000-\u001f\u007f<>:"|?*]/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}
function publicSource(path) {
  if (!safePath(path) || path.split('/').some(part => /^(?:private|backups|handoff|node_modules|dist|\.cache|\.git)$/i.test(part))) return false;
  const name = path.split('/').at(-1);
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example') || /(?:token|credential|\.local\.json|\.log)$/i.test(name)) return false;
  return publicRoots.has(path) || /^(?:src|scripts|test)\//.test(path);
}
function git(root, args) {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Release source Git read failed: ' + (result.error?.message || result.stderr));
  return result.stdout;
}
async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Release inputs and outputs must be regular files without links');
}
async function archive(root, description, license) {
  if (!description || !['package.zip', 'bridge-companion.zip'].includes(description.file) || !description.files || typeof description.files !== 'object') throw new Error('Invalid package manifest identity');
  const path = join(root, 'dist', description.file);
  await regular(path);
  const bytes = await readFile(path);
  if (hash(bytes) !== description.sha256) throw new Error('Package SHA-256 checksum differs from verified package manifest');
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const paths = Object.keys(zip.files).sort();
  if (JSON.stringify(paths) !== JSON.stringify(Object.keys(description.files).sort())) throw new Error('Package archive member list differs from manifest');
  for (const name of paths) {
    const entry = zip.files[name];
    if (!safePath(name) || entry.dir || (entry.unsafeOriginalName && entry.unsafeOriginalName !== name)) throw new Error('Unsafe package archive member');
    if (hash(await entry.async('nodebuffer')) !== description.files[name]) throw new Error('Package member checksum differs from manifest');
  }
  const projectLicense = zip.file('LICENSE');
  if (!projectLicense || !(await projectLicense.async('nodebuffer')).equals(license)) throw new Error('Package project license must match the complete source LICENSE');
  return { bytes, zip };
}

export async function createReleaseArtifacts(root = scriptRoot) {
  root = resolve(root);
  const records = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t(.+)$/s.exec(line);
    if (!match) throw new Error('Tracked source must have a regular file mode without links');
    const [, mode, sha, path] = match;
    if (!publicSource(path)) throw new Error('Tracked private or non-public source path is not allowed: ' + path);
    return { path, mode, sha };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const names = new Set(records.map(entry => entry.path));
  for (const required of ['package.json', 'plugin.json', 'LICENSE', 'README.md']) if (!names.has(required)) throw new Error('Required public source is not tracked: ' + required);
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('Uncommitted tracked source changes cannot be released');
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid public source commit');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  if (pkg.name !== 'siyuan-ai-collab' || plugin.name !== pkg.name || !/^\d+\.\d+\.\d+$/.test(pkg.version) || plugin.version !== pkg.version || plugin.author !== 'chings-yan' || plugin.url !== 'https://github.com/chings-yan/siyuan-ai-work' || pkg.license !== 'AGPL-3.0-only') throw new Error('Public release identity, version or license does not match');
  const license = await readProjectLicense(root, pkg);
  const dist = join(root, 'dist');
  const distInfo = await lstat(dist);
  if (!distInfo.isDirectory() || distInfo.isSymbolicLink()) throw new Error('Release dist must be a regular project directory');
  await regular(join(dist, 'package-manifest.json'));
  const packages = JSON.parse(await readFile(join(dist, 'package-manifest.json'), 'utf8'));
  if (packages.name !== pkg.name || packages.version !== pkg.version || packages.plugin?.file !== 'package.zip' || packages.companion?.file !== 'bridge-companion.zip') throw new Error('Built package identity or version differs from source');
  const frontend = await archive(root, packages.plugin, license);
  const companion = await archive(root, packages.companion, license);
  const frontendFiles = [...frontendPackageFiles(plugin), 'LICENSE'].sort();
  if (JSON.stringify(Object.keys(frontend.zip.files).sort()) !== JSON.stringify(frontendFiles)) throw new Error('Frontend archive whitelist differs');
  const archivedPlugin = JSON.parse(await frontend.zip.file('plugin.json').async('string'));
  if (JSON.stringify(archivedPlugin) !== JSON.stringify(plugin)) throw new Error('Frontend package identity differs from source');
  if (plugin.icon) {
    const iconPath = join(root, plugin.icon);
    if (!names.has(plugin.icon)) throw new Error('The marketplace icon must be tracked in the release source');
    await regular(iconPath);
    if (!(await frontend.zip.file(plugin.icon).async('nodebuffer')).equals(await readFile(iconPath))) throw new Error('Frontend marketplace icon differs from source');
  }
  const identity = JSON.parse(await companion.zip.file('companion-manifest.json')?.async('string') || 'null');
  if (identity?.pluginName !== pkg.name || identity?.pluginVersion !== pkg.version || identity?.track !== packages.track) throw new Error('Companion identity differs from source');

  const sourceZip = new JSZip();
  const files = [];
  for (const entry of records) {
    await regular(join(root, entry.path));
    const bytes = await readFile(join(root, entry.path));
    if (gitBlob(bytes) !== entry.sha) throw new Error('Tracked source bytes changed: ' + entry.path);
    sourceZip.file(entry.path, bytes, { createFolders: false });
    files.push({ path: entry.path, bytes: bytes.length, sha256: hash(bytes) });
  }
  const sourceName = `siyuan-ai-collab-${pkg.version}-source.zip`;
  const outputs = [sourceName, 'source-manifest.json', 'SHA256SUMS'];
  for (const name of outputs) {
    try { await regular(join(dist, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const zipBytes = await sourceZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const readback = await JSZip.loadAsync(zipBytes, { checkCRC32: true });
  if (JSON.stringify(Object.keys(readback.files).sort()) !== JSON.stringify(files.map(file => file.path).sort())) throw new Error('Source archive inventory differs');
  for (const file of files) if (hash(await readback.file(file.path).async('nodebuffer')) !== file.sha256) throw new Error('Source archive bytes differ');
  await writeFile(join(dist, sourceName), zipBytes);
  await writeFile(join(dist, 'source-manifest.json'), JSON.stringify({ version: pkg.version, license: pkg.license, commit, files }, null, 2) + '\n');
  const assetNames = ['package.zip', 'bridge-companion.zip', sourceName, 'package-manifest.json', 'source-manifest.json'];
  const checksums = [];
  for (const name of assetNames) checksums.push(`${hash(await readFile(join(dist, name)))}  ${name}`);
  await writeFile(join(dist, 'SHA256SUMS'), checksums.join('\n') + '\n');
  return { version: pkg.version, commit, sourceFiles: files.length, assets: [...assetNames, 'SHA256SUMS'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await createReleaseArtifacts(process.argv[2] || scriptRoot);
  console.log(JSON.stringify(result));
}
