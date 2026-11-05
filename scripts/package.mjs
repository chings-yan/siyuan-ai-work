import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import JSZip from 'jszip';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontendFiles = ['plugin.json', 'README.md', 'index.js'];
const companionEntries = ['bridge.mjs', 'bridge-supervisor.mjs', 'pair.mjs'];
const windowsEntries = ['prepare-bridge.cmd', 'start-bridge.cmd'];
const serveLauncher = 'hermes-serve-launcher.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
// Standard SPDX AGPL-3.0-only text; normalize Windows line endings for validation only.
const projectLicenseDigest = 'd8a6cc31abc16b6748c7a21f21611f5a1ec33f67d22ca23d7da1c19b95496bee';
const slash = value => value.split(sep).join('/');

async function optionalStat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function readProjectLicense(root, pkg) {
  // Historical unlicensed fixtures retain their original distribution contract.
  if (pkg.license === undefined) return null;
  if (pkg.license !== 'AGPL-3.0-only') throw new Error('Project license must be AGPL-3.0-only');
  const path = join(root, 'LICENSE');
  const info = await optionalStat(path);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error('Project license must be a regular LICENSE file, without links');
  const bytes = await readFile(path);
  if (hash(bytes.toString('utf8').replace(/\r\n/g, '\n')) !== projectLicenseDigest) {
    throw new Error('Project license text does not match the complete standard AGPL-3.0-only text');
  }
  return bytes;
}
function assertChild(parent, path) {
  const child = relative(parent, path);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('Package output must stay inside the project dist directory');
}
async function outputPaths(root) {
  const dist = join(root, 'dist');
  if ((await optionalStat(dist))?.isSymbolicLink()) throw new Error('Refusing a symbolic-link dist directory');
  await mkdir(dist, { recursive: true });
  assertChild(await realpath(root), await realpath(dist));
  const directories = [join(dist, 'siyuan-ai-collab'), join(dist, 'bridge-companion')];
  // Validate every destination before removing any previous generated output.
  for (const path of [...directories, join(dist, 'package.zip'), join(dist, 'bridge-companion.zip'), join(dist, 'package-manifest.json')]) {
    assertChild(dist, path);
    if ((await optionalStat(path))?.isSymbolicLink()) throw new Error('Refusing a symbolic-link package output');
  }
  for (const path of directories) {
    if (dirname(path) !== dist) throw new Error('Invalid package output');
    await rm(path, { recursive: true, force: true });
    await mkdir(path);
  }
  return { dist, plugin: directories[0], companion: directories[1] };
}
async function filesBelow(root, path = root) {
  const result = [];
  for (const item of await readdir(path, { withFileTypes: true })) {
    const full = join(path, item.name);
    if (item.isSymbolicLink()) throw new Error('Symbolic links are not allowed in distribution files');
    if (item.isDirectory()) result.push(...await filesBelow(root, full));
    else if (item.isFile()) result.push(slash(relative(root, full)));
  }
  return result.sort();
}
async function writeVerifiedZip(directory, paths, destination) {
  const zip = new JSZip();
  const checksums = {};
  for (const name of paths) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('Invalid archive entry');
    const data = await readFile(join(directory, name));
    checksums[name] = hash(data);
    zip.file(name, data, { createFolders: false });
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await writeFile(destination, bytes);
  const readback = await readFile(destination);
  const reopened = await JSZip.loadAsync(readback, { checkCRC32: true });
  const actual = Object.keys(reopened.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...paths].sort())) throw new Error('Archive entry verification failed');
  for (const name of paths) {
    if (hash(await reopened.file(name).async('nodebuffer')) !== checksums[name]) throw new Error('Archive content verification failed');
  }
  return { file: slash(relative(dirname(destination), destination)), sha256: hash(readback), files: checksums };
}
async function dependencyNotices(root, output, inputs, projectLicense) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!slash(input).includes('node_modules/')) continue;
    let folder = dirname(resolve(root, input));
    // Build subdirectories may repeat package identity but omit the license.
    // Select the actual installed package root at its node_modules boundary.
    while (dirname(folder) !== folder) {
      const parent = dirname(folder);
      if (basename(parent) === 'node_modules' || (basename(parent).startsWith('@') && basename(dirname(parent)) === 'node_modules')) break;
      folder = dirname(folder);
    }
    const info = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'));
    if (typeof info.name !== 'string' || typeof info.version !== 'string') throw new Error('Bundled dependency package identity was not found');
    if (!packages.has(info.name)) packages.set(info.name, { folder, info });
  }
  const notes = ['# Bundled runtime dependency notices', '', projectLicense
    ? 'Project license: AGPL-3.0-only. See LICENSE. Third-party dependencies retain their own licenses.'
    : 'The plugin project license is not assigned by this packaging tool.', ''];
  for (const [name, { folder, info }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    notes.push(`- ${name} ${info.version} (${typeof info.license === 'string' ? info.license : 'See package notice'})`);
    const licenses = (await readdir(folder)).filter(name => /^(licen[cs]e|copying|notice)([-.]|$)/i.test(name));
    for (const license of licenses) {
      const source = join(folder, license);
      if (!(await lstat(source)).isFile()) continue;
      const target = join(output, 'LICENSES', `${name.replace(/[^a-z0-9_.-]/gi, '_')}-${license}`);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
  }
  await writeFile(join(output, 'THIRD-PARTY-NOTICES.md'), notes.join('\n') + '\n');
}

export async function buildPackages(root = scriptRoot) {
  root = resolve(root);
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'));
  if (pkg.name !== 'siyuan-ai-collab' || manifest.name !== pkg.name || manifest.version !== pkg.version) {
    throw new Error('Plugin identity and version must match package.json');
  }
  const projectLicense = await readProjectLicense(root, pkg);
  for (const file of windowsEntries) {
    const source = await optionalStat(join(root, 'scripts', file));
    if (!source?.isFile() || source.isSymbolicLink()) throw new Error(`Windows entry must be a regular public source file: ${file}`);
  }
  const out = await outputPaths(root);
  for (const file of frontendFiles) await copyFile(join(root, file === 'index.js' ? 'dist/index.js' : file), join(out.plugin, file));
  const packageFrontendFiles = projectLicense ? [...frontendFiles, 'LICENSE'] : frontendFiles;
  if (projectLicense) {
    await writeFile(join(out.plugin, 'LICENSE'), projectLicense);
    await writeFile(join(out.companion, 'LICENSE'), projectLicense);
  }
  const scripts = join(out.companion, 'scripts');
  await mkdir(scripts);
  for (const file of windowsEntries) await copyFile(join(root, 'scripts', file), join(out.companion, file));
  const entries = [...companionEntries];
  const launcherStat = await optionalStat(join(root, 'scripts', serveLauncher));
  if (launcherStat) {
    if (!launcherStat.isFile() || launcherStat.isSymbolicLink()) throw new Error('Serve launcher must be a regular public source file');
    entries.push(serveLauncher);
  }
  // Bundle runtime dependencies; users need Node.js, not this project's development dependencies.
  const bundled = await build({
    absWorkingDir: root, entryPoints: entries.map(file => `scripts/${file}`),
    outdir: scripts, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    legalComments: 'eof', metafile: true, logLevel: 'silent',
    define: { __SAC_BRIDGE_VERSION__: JSON.stringify(pkg.version) },
    banner: { js: "import { createRequire as __packageCreateRequire } from 'node:module'; const require = __packageCreateRequire(import.meta.url);" },
  });
  await copyFile(join(root, 'scripts/.env.example'), join(scripts, '.env.example'));
  if (launcherStat) await copyFile(join(root, 'scripts/hermes-serve.env.example'), join(scripts, 'hermes-serve.env.example'));
  const companionIdentity = {
    schemaVersion: 1, pluginName: manifest.name, pluginVersion: manifest.version,
    track: launcherStat ? 'shared-service' : 'studio-compatible',
  };
  await writeFile(join(out.companion, 'companion-manifest.json'), JSON.stringify(companionIdentity, null, 2) + '\n');
  const guide = await readFile(join(root, 'docs/BRIDGE-SETUP.md'), 'utf8');
  const trackLabel = launcherStat ? '统一兼容版' : 'Studio 兼容版';
  const identityHeader = `# Bridge Companion\n\n插件：${companionIdentity.pluginName}  \n版本：${companionIdentity.pluginVersion}  \n发布轨道：${companionIdentity.track}（${trackLabel}）\n\n---\n\n`;
  await writeFile(join(out.companion, 'README.md'), identityHeader + guide);
  await dependencyNotices(root, out.companion, bundled.metafile.inputs, projectLicense);
  const companionFiles = await filesBelow(out.companion);
  const plugin = await writeVerifiedZip(out.plugin, packageFrontendFiles, join(out.dist, 'package.zip'));
  const companion = await writeVerifiedZip(out.companion, companionFiles, join(out.dist, 'bridge-companion.zip'));
  const result = { name: manifest.name, version: manifest.version, track: companionIdentity.track, plugin, companion };
  await writeFile(join(out.dist, 'package-manifest.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildPackages();
  console.log(JSON.stringify({ version: result.version, plugin: result.plugin.file, companion: result.companion.file }));
}
