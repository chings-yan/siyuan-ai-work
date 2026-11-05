import { readFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HASH = 'e4ee2e69f054d5a390a96a6361cf02f97f02519ae6754ddf6bdfc74ec082ae30';
// Independently reproduced edf build from the historical local installation.
// Only these exact bytes are approved; directory-label normalization is not used.
const LOCAL_HASH = 'efc8385fe278c9c7d297c266f9d2c508c9032c8086b183f39d697a87bcc2e9dc';
const SOURCE_COMMIT = 'edf984b43ba7d4b2e1886d5cc51e3bd2dae44a3e';
const KINDS = new Set(['serve', 'studio', 'legacy-api']);
const STATES = new Set(['ready', 'configured', 'auth_missing', 'auth_failed', 'offline', 'incompatible']);
const fail = code => Object.assign(new Error('Diagnostic failed'), { diagnosticCode: code });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && Boolean(value.trim());
const type = (body, key) => !record(body) || !Object.hasOwn(body, key) ? 'missing' : body[key] === null ? 'null' : Array.isArray(body[key]) ? 'array' : ['boolean', 'number', 'string', 'object'].includes(typeof body[key]) ? typeof body[key] : 'other';
function validInstallationRecord(value) {
  const keys = ['sourceCommit', 'pluginVersion', 'recordedPublicBridgeSha256'];
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && value.sourceCommit === SOURCE_COMMIT && value.pluginVersion === '0.3.5'
    && typeof value.recordedPublicBridgeSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.recordedPublicBridgeSha256);
}
export function verifyPackageIdentity(actualBridgeSha256, installationRecord, manifest) {
  if (actualBridgeSha256 !== HASH && actualBridgeSha256 !== LOCAL_HASH) throw fail('package_mismatch');
  const provided = installationRecord !== undefined;
  if (!provided && actualBridgeSha256 === LOCAL_HASH) throw fail('installation_record_required');
  if (provided) {
    if (!validInstallationRecord(installationRecord) || installationRecord.recordedPublicBridgeSha256 !== actualBridgeSha256) throw fail('installation_record_invalid');
    if (!record(manifest) || manifest.schemaVersion !== 1 || manifest.pluginName !== 'siyuan-ai-collab' || manifest.pluginVersion !== '0.3.5' || manifest.track !== 'shared-service') throw fail('companion_manifest_invalid');
  }
  // Matching the supplied public fields does not authenticate the history file
  // or identify the code already loaded by a running Bridge process.
  return { verified: true, verificationBasis: actualBridgeSha256 === HASH ? 'cloud-artifact' : 'recorded-local-build', installationRecordMatched: provided ? true : null, runningProcessVerified: false };
}
function origin(raw) {
  if (!/^http:\/\/127\.0\.0\.1(?::\d{1,5})?\/?$/.test(raw)) throw fail('invalid_arguments');
  try { return new URL(raw).href; } catch { throw fail('invalid_arguments'); }
}
async function bounded(operation, ms, upstream) {
  const controller = new AbortController(); let timer, abort;
  const deadline = new Promise((_, reject) => {
    abort = () => reject(fail('timeout'));
    timer = setTimeout(() => { controller.abort(); abort(); }, ms);
    upstream?.addEventListener('abort', abort, { once: true });
  });
  try {
    if (upstream?.aborted) throw fail('timeout');
    return await Promise.race([Promise.resolve().then(() => operation(AbortSignal.any([controller.signal, ...(upstream ? [upstream] : [])]))), deadline]);
  } finally { clearTimeout(timer); upstream?.removeEventListener('abort', abort); controller.abort(); }
}
async function explicitFile(path, ms) {
  return bounded(async signal => {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw fail('file_unavailable');
    return readFile(path, { signal });
  }, ms);
}
async function loadVerifiedBundle(root, ms, installationRecordPath) {
  const file = join(root, 'scripts', 'bridge.mjs');
  let bytes, installationRecord, manifest;
  if (installationRecordPath !== undefined) {
    try { installationRecord = JSON.parse((await explicitFile(installationRecordPath, ms)).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw fail('installation_record_invalid'); }
    if (!validInstallationRecord(installationRecord)) throw fail('installation_record_invalid');
  }
  try { bytes = await explicitFile(file, ms); } catch { throw fail('package_mismatch'); }
  if (installationRecordPath !== undefined) {
    try { manifest = JSON.parse((await explicitFile(join(root, 'companion-manifest.json'), ms)).toString('utf8')); }
    catch { throw fail('companion_manifest_invalid'); }
  }
  const verification = verifyPackageIdentity(createHash('sha256').update(bytes).digest('hex'), installationRecord, manifest);
  return { bundle: await import(pathToFileURL(file).href), verification };
}
const transportState = response => response.redirected || response.status >= 300 && response.status < 400 ? 'redirect_denied'
  : [401, 403].includes(response.status) ? 'auth_failed' : [404, 405].includes(response.status) ? 'incompatible' : !response.ok ? 'offline' : 'ok';
const readSummary = response => ({ httpStatus: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null, redirected: response.redirected === true, transport: transportState(response) });
async function observedRead(url, headers, fetchImpl, ms, upstream, observe = () => {}) {
  return bounded(async signal => {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', headers, signal });
    const transport = transportState(response);
    observe(readSummary(response));
    if (transport !== 'ok') return { response, transport };
    let body, bodyError, failed = false;
    try { body = await response.json(); } catch (error) { failed = true; bodyError = error; }
    // Consume the original body once; the verified package receives exactly
    // this same value or original failure, without cloning/re-reading it.
    response.json = async () => { if (failed) throw bodyError; return body; };
    return { response, body, transport: failed ? bodyError instanceof SyntaxError ? 'invalid_json' : 'body_read_failed' : 'ok' };
  }, ms, upstream);
}
function summarize(body, phase, indexProfiles, checks, types) {
  const array = record(body) && Array.isArray(body.sessions), rows = array ? body.sessions : [];
  checks[`${phase}BodyObject`] = record(body); checks[`${phase}SessionsArray`] = Boolean(array);
  checks[`${phase}IdsValid`] = Boolean(array) && rows.every(row => record(row) && text(row.id));
  types[`${phase}ProfileTypes`] = [...new Set(rows.map(row => type(row, 'profile')))].sort();
  if (phase === 'index') {
    checks.indexProfilesValid = Boolean(array) && rows.every(row => record(row) && text(row.profile));
    checks.indexDuplicateProfilesConsistent = true;
    for (const row of rows) if (record(row) && text(row.id) && text(row.profile)) {
      if (indexProfiles.has(row.id) && indexProfiles.get(row.id) !== row.profile) checks.indexDuplicateProfilesConsistent = false;
      indexProfiles.set(row.id, row.profile);
    }
    return;
  }
  checks.canonicalMissingProfilesKnown = rows.every(row => !record(row) || Object.hasOwn(row, 'profile') || indexProfiles.has(row.id));
  checks.canonicalExplicitProfilesValid = rows.every(row => !record(row) || !Object.hasOwn(row, 'profile') || text(row.profile));
  checks.canonicalIndexProfilesConsistent = rows.every(row => !record(row) || !Object.hasOwn(row, 'profile') || !indexProfiles.has(row.id) || indexProfiles.get(row.id) === row.profile);
  const seen = new Map(); checks.canonicalDuplicatesConsistent = true;
  for (const row of rows) if (record(row)) {
    const profile = Object.hasOwn(row, 'profile') ? row.profile : indexProfiles.get(row.id);
    if (seen.has(row.id) && seen.get(row.id) !== profile) checks.canonicalDuplicatesConsistent = false;
    seen.set(row.id, profile);
  }
  for (const key of ['hasMore', 'offset', 'limit']) types[key] = type(body, key);
  checks.canonicalHasMoreValid = types.hasMore === 'missing' || typeof body.hasMore === 'boolean';
  checks.canonicalOffsetValid = types.offset === 'missing' || body.offset === 0;
  checks.canonicalLimitValid = types.limit === 'missing' || Number.isInteger(body.limit) && body.limit > 0;
  checks.canonicalPagingAdvances = body?.hasMore !== true || body.offset === 0 && Number.isInteger(body.limit) && body.limit > 0;
}
async function liveBridge(base, token, fetchImpl, ms) {
  const reads = {}; let current = 'healthRead';
  const read = async (path, headers) => {
    const result = await observedRead(new URL(path, base), headers, fetchImpl, ms, undefined, value => { reads[current] = value; });
    reads[current].transport = result.transport; return result;
  };
  try {
    const health = await read('/health', {});
    if (health.transport !== 'ok') return { ...reads, health: health.transport, connections: [] };
    if (health.body?.ok !== true || health.body?.service !== 'siyuan-ai-collab-bridge') return { ...reads, health: 'invalid_payload', connections: [] };
    current = 'connectionsRead';
    const result = await read('/connections', { 'X-Siyuan-Collab-Token': token });
    if (result.transport !== 'ok') return { ...reads, health: 'verified', status: result.transport, connections: [] };
    if (!Array.isArray(result.body?.data) || !result.body.data.every(row => KINDS.has(row?.kind) && STATES.has(row?.state))) return { ...reads, health: 'verified', status: 'invalid_payload', connections: [] };
    return { ...reads, health: 'verified', status: 'ok', connections: result.body.data.map(row => ({ kind: row.kind, state: row.state })) };
  } catch (error) {
    const transport = error?.diagnosticCode === 'timeout' ? 'timeout' : 'offline';
    reads[current] = { httpStatus: null, redirected: false, ...reads[current], transport };
    return { ...reads, health: current === 'healthRead' ? transport : 'verified', status: transport, connections: [] };
  }
}
async function independentProbe(createBridgeServer, studioBase, token, fetchImpl, ms, directory) {
  const checks = {}, types = {}, reads = {}, indexProfiles = new Map(); let transport = 'not_read';
  const allowed = ['/api/studio/sessions', '/api/studio/sessions/hermes?offset=0&limit=1'].map(path => new URL(path, studioBase).href);
  const wrappedFetch = async (raw, init) => {
    const position = allowed.indexOf(String(raw));
    if (position < 0 || init?.method !== 'GET' || init.redirect !== 'manual' || !init.signal || init.body !== undefined || new Headers(init.headers).get('Authorization') !== `Bearer ${token}`) throw fail('request_denied');
    const phase = position === 0 ? 'index' : 'canonical';
    try {
      const result = await observedRead(new URL(allowed[position]), { Authorization: `Bearer ${token}` }, fetchImpl, ms, init.signal, value => { reads[phase] = value; });
      transport = result.transport;
      reads[phase].transport = transport;
      if (transport === 'ok') summarize(result.body, phase, indexProfiles, checks, types);
      return result.response;
    } catch (error) { transport = error?.diagnosticCode === 'timeout' ? 'timeout' : 'offline'; reads[phase] = { httpStatus: null, redirected: false, ...reads[phase], transport }; throw error; }
  };
  const deny = () => { throw fail('request_denied'); };
  const capability = 'independent-read-only-capability-'.repeat(3);
  const { server } = createBridgeServer({ capability, studioBase, tokenProvider: async () => token, fetchImpl: wrappedFetch, probeTimeoutMs: ms,
    hermesBase: studioBase, bindingsFile: join(directory, 'bindings-unused'), bindingsV2File: join(directory, 'v2-unused'),
    connections: { defaultConnectionId: 'studio-default', connections: [{ id: 'studio-default', kind: 'studio', profile: 'default' }] },
    ekko: { authStore: { read: deny, write: deny }, pendingDirectory: join(directory, 'ekko-unused') }, studioRun: deny, gatewayFactory: deny, origins: [] });
  try {
    const body = await bounded(() => new Promise((resolveResult, reject) => {
      const req = Object.assign(new EventEmitter(), { url: '/connections', method: 'GET', headers: { 'x-siyuan-collab-token': capability } });
      const res = { headersSent: false, writeHead() { this.headersSent = true; }, end(raw) { try { resolveResult(JSON.parse(raw)); } catch { reject(fail('invalid_payload')); } }, destroy() { reject(fail('invalid_payload')); } };
      const log = console.log;
      try { console.log = () => {}; server.emit('request', req, res); } finally { console.log = log; }
    }), ms + 100);
    const state = STATES.has(body?.data?.[0]?.state) ? body.data[0].state : 'unknown';
    return { state, transport, reads, checks, types, firstFailure: Object.keys(checks).find(key => checks[key] === false) || (transport === 'ok' ? null : transport) };
  } finally { server.close(); }
}

export async function runDiagnostics(options, { fetchImpl = fetch, timeoutMs = 5_000, loadBundle = loadVerifiedBundle } = {}) {
  let directory;
  try {
    if (!options || !['companionRoot', 'bridgeUrl', 'bridgeTokenFile', 'studioUrl', 'studioTokenFile'].every(key => text(options[key]))) throw fail('invalid_arguments');
    if (Object.hasOwn(options, 'installationRecord') && !text(options.installationRecord)) throw fail('invalid_arguments');
    const bridge = origin(options.bridgeUrl), studio = origin(options.studioUrl);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) throw fail('invalid_arguments');
    const loaded = await loadBundle(resolve(options.companionRoot), timeoutMs, options.installationRecord);
    const { bundle, verification } = loadBundle === loadVerifiedBundle ? loaded : { bundle: loaded, verification: { verified: true, runningProcessVerified: false } };
    if (typeof bundle?.createBridgeServer !== 'function') throw fail('package_mismatch');
    let bridgeToken, studioToken;
    try { bridgeToken = (await explicitFile(options.bridgeTokenFile, timeoutMs)).toString('utf8').trim(); studioToken = (await explicitFile(options.studioTokenFile, timeoutMs)).toString('utf8').trim(); }
    catch { throw fail('credentials_unavailable'); }
    if (bridgeToken.length < 64 || !studioToken) throw fail('credentials_unavailable');
    directory = await mkdtemp(join(tmpdir(), 'hermes-read-diagnostic-'));
    const rounds = [];
    for (let round = 0; round < 2; round++) rounds.push({ liveBridge: await liveBridge(bridge, bridgeToken, fetchImpl, timeoutMs), independentPackageProbe: await independentProbe(bundle.createBridgeServer, studio, studioToken, fetchImpl, timeoutMs, directory) });
    return { status: 'complete', package: verification, rounds };
  } catch (error) { return { status: 'refused', reason: ['invalid_arguments', 'package_mismatch', 'installation_record_required', 'installation_record_invalid', 'companion_manifest_invalid', 'credentials_unavailable'].includes(error?.diagnosticCode) ? error.diagnosticCode : 'diagnostic_unavailable' }; }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
function argumentsOf(argv) {
  const keys = { '--companion-root': 'companionRoot', '--bridge-url': 'bridgeUrl', '--bridge-token-file': 'bridgeTokenFile', '--studio-url': 'studioUrl', '--studio-token-file': 'studioTokenFile', '--installation-record': 'installationRecord' }, result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!Object.hasOwn(keys, argv[i])) throw fail('invalid_arguments');
    const key = keys[argv[i]];
    if (!key || Object.hasOwn(result, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw fail('invalid_arguments');
    result[key] = argv[i + 1];
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = await runDiagnostics(argumentsOf(process.argv.slice(2))); } catch { result = { status: 'refused', reason: 'invalid_arguments' }; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'refused') process.exitCode = 1;
}
