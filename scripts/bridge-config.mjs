import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultProjectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pathKeys = ['SIYUAN_BRIDGE_PROJECT_ROOT','SIYUAN_BRIDGE_DATA_DIR','SIYUAN_BRIDGE_ENV_FILE','SIYUAN_HERMES_ENV','SIYUAN_BRIDGE_TOKEN_FILE','HERMES_STUDIO_TOKEN_FILE','SIYUAN_BRIDGE_BINDINGS_FILE','SIYUAN_BRIDGE_BINDINGS_V2_FILE','SIYUAN_EKKO_CONNECTION_FILE','SIYUAN_EKKO_PENDING_DIR','SIYUAN_BRIDGE_LOG','SIYUAN_BRIDGE_LOCK','SIYUAN_HERMES_SERVE_TOKEN_FILE','HERMES_SERVE_TOKEN_FILE'];

// A higher source's primary path also owns its derived defaults. A lower
// source cannot inject a token file over an explicitly supplied inline token.
function mergeLayers(higher, lower, localDefaults = false) {
  const values = { ...lower, ...higher };
  for (const [primary,derived] of [['SIYUAN_BRIDGE_BINDINGS_FILE','SIYUAN_BRIDGE_BINDINGS_V2_FILE'],['SIYUAN_EKKO_CONNECTION_FILE','SIYUAN_EKKO_PENDING_DIR'],['SIYUAN_BRIDGE_TOKEN','SIYUAN_BRIDGE_TOKEN_FILE']]) {
    if ((localDefaults || primary === 'SIYUAN_BRIDGE_TOKEN') && higher[primary] !== undefined && higher[derived] === undefined) delete values[derived];
  }
  return values;
}
function absolutePaths(values, cwd) {
  const result = { ...values };
  for (const key of pathKeys) if (typeof result[key] === 'string' && result[key]) result[key] = resolve(cwd,result[key]);
  return result;
}

export function resolveBridgeConfig(env = process.env, { projectRoot = defaultProjectRoot, home = homedir(), platform = process.platform, localConfig = {}, cwd = process.cwd() } = {}) {
  const values = absolutePaths(mergeLayers(env,localConfig,true),cwd);
  const root = resolve(cwd,values.SIYUAN_BRIDGE_PROJECT_ROOT || projectRoot);
  const dataRoot = resolve(cwd,values.SIYUAN_BRIDGE_DATA_DIR || (platform === 'win32' ? join(values.LOCALAPPDATA || join(home,'AppData','Local'),'siyuan-ai-collab') : platform === 'darwin' ? join(home,'Library','Application Support','siyuan-ai-collab') : join(values.XDG_DATA_HOME || join(home,'.local','share'),'siyuan-ai-collab')));
  const host = values.SIYUAN_BRIDGE_HOST || '127.0.0.1';
  if (!['127.0.0.1','::1'].includes(host)) throw new Error('Bridge host 必须为 loopback 地址 127.0.0.1 或 ::1');
  const rawPort = values.SIYUAN_BRIDGE_PORT || '8782';
  const port = Number(rawPort);
  if (!/^\d+$/.test(String(rawPort)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Bridge 端口无效');
  const bindingsFile = values.SIYUAN_BRIDGE_BINDINGS_FILE || join(dataRoot,'siyuan-ai-collab-bindings.json');
  const ekkoFile = values.SIYUAN_EKKO_CONNECTION_FILE || join(dataRoot,'ekko-connection.json');
  return {
    projectRoot:root, dataRoot, host, port,
    envFile:values.SIYUAN_BRIDGE_ENV_FILE || values.SIYUAN_HERMES_ENV || null,
    tokenFile:values.SIYUAN_BRIDGE_TOKEN_FILE || join(dataRoot,'bridge-token'),
    studioTokenFile:values.HERMES_STUDIO_TOKEN_FILE || join(home,'.hermes-web-ui','profiles','default','.model-run-token'),
    bindingsFile,
    bindingsV2File:values.SIYUAN_BRIDGE_BINDINGS_V2_FILE || join(dirname(bindingsFile),'siyuan-ai-collab-bindings-v2.json'),
    ekkoFile,
    pendingDirectory:values.SIYUAN_EKKO_PENDING_DIR || join(dirname(ekkoFile),'ekko-pending-sends'),
    logPath:values.SIYUAN_BRIDGE_LOG || join(dataRoot,'bridge.log'),
    lockPath:values.SIYUAN_BRIDGE_LOCK || join(dataRoot,'bridge.lock'),
  };
}

function readLocalPaths(projectRoot) {
  try {
    const local = JSON.parse(readFileSync(join(projectRoot,'bridge.local.json'),'utf8'));
    if (!local || typeof local !== 'object' || Array.isArray(local) || Object.entries(local).some(([key,value]) => !pathKeys.includes(key) || typeof value !== 'string' || !value.trim())) throw new Error('invalid');
    return absolutePaths(local,projectRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error('Bridge 本地路径配置无效；请核对 bridge.local.json');
  }
}
function readEnvironmentFile(path) {
  let text;
  try { text = readFileSync(path,'utf8'); }
  catch { throw new Error('指定的 Bridge 环境文件不可读；请核对配置路径'); }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && values[match[1]] === undefined) values[match[1]] = match[2].replace(/^['"]|['"]$/g,'');
  }
  return values;
}

// Load one selected environment file, determine the explicit source root, then
// merge only that source's local paths. Imports never load configuration/state.
// Process/file relative paths use the invocation cwd; local paths use their
// configuration directory. Forward absolute paths before child cwd changes.
export function loadBridgeEnvironment(env = process.env, { projectRoot = defaultProjectRoot, cwd = process.cwd() } = {}) {
  const initialRoot = resolve(cwd,env.SIYUAN_BRIDGE_PROJECT_ROOT || projectRoot);
  const explicitFile = env.SIYUAN_BRIDGE_ENV_FILE || env.SIYUAN_HERMES_ENV;
  const locator = explicitFile ? {} : readLocalPaths(initialRoot);
  const selectedFile = explicitFile || locator.SIYUAN_BRIDGE_ENV_FILE || locator.SIYUAN_HERMES_ENV;
  const envFile = selectedFile ? resolve(cwd,selectedFile) : null;
  const explicit = absolutePaths(mergeLayers(env,envFile ? readEnvironmentFile(envFile) : {}),cwd);
  const finalRoot = explicit.SIYUAN_BRIDGE_PROJECT_ROOT || initialRoot;
  const local = readLocalPaths(finalRoot);
  const values = mergeLayers(explicit,local,true);
  // Local maps only defaults for the selected source; it must not redirect it.
  values.SIYUAN_BRIDGE_PROJECT_ROOT = finalRoot;
  if (envFile) values.SIYUAN_BRIDGE_ENV_FILE = envFile;
  Object.assign(env,values);
  return resolveBridgeConfig(values,{projectRoot:finalRoot,cwd});
}

export function bridgeChildEnvironment(config, env = process.env) {
  return { ...absolutePaths(env,process.cwd()), SIYUAN_BRIDGE_PROJECT_ROOT:config.projectRoot, SIYUAN_BRIDGE_DATA_DIR:config.dataRoot,
    ...(env.SIYUAN_BRIDGE_TOKEN && !env.SIYUAN_BRIDGE_TOKEN_FILE ? {} : {SIYUAN_BRIDGE_TOKEN_FILE:config.tokenFile}), HERMES_STUDIO_TOKEN_FILE:config.studioTokenFile,
    ...(config.envFile ? {SIYUAN_BRIDGE_ENV_FILE:config.envFile} : {}),
    SIYUAN_BRIDGE_BINDINGS_FILE:config.bindingsFile, SIYUAN_BRIDGE_BINDINGS_V2_FILE:config.bindingsV2File,
    SIYUAN_EKKO_CONNECTION_FILE:config.ekkoFile, SIYUAN_EKKO_PENDING_DIR:config.pendingDirectory,
    SIYUAN_BRIDGE_LOG:config.logPath, SIYUAN_BRIDGE_LOCK:config.lockPath,
    SIYUAN_BRIDGE_HOST:config.host, SIYUAN_BRIDGE_PORT:String(config.port) };
}
