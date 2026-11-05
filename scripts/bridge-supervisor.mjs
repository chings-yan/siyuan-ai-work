import { request } from 'node:http';
import { open, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBridgeConfig, loadBridgeEnvironment, bridgeChildEnvironment } from './bridge-config.mjs';
import process from 'node:process';

export function supervisorLaunch(config = resolveBridgeConfig(), env = process.env) {
  return { args:[join(config.projectRoot,'scripts','bridge.mjs')], options:{cwd:config.projectRoot,env:bridgeChildEnvironment(config,env),stdio:'inherit',windowsHide:true}, health:{host:config.host,port:config.port} };
}

export function backoffDelay(restarts, { baseMs = 1000, maxMs = 30000 } = {}) {
  return Math.min(maxMs, baseMs * (2 ** restarts));
}

export async function acquireInstanceLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(String(process.pid));
    return { release: async () => { await handle.close(); await unlink(lockPath).catch(() => {}); } };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    let pid = 0;
    try { pid = Number((await readFile(lockPath, 'utf8')).trim()); } catch { stale = true; }
    if (!stale && pid === process.pid) throw new Error('already running');
    if (!stale && !pid) stale = true;
    if (!stale) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') stale = true; } }
    if (stale) { await unlink(lockPath).catch(() => {}); return acquireInstanceLock(lockPath); }
    throw new Error('already running');
  }
}

export function probeHealth(port = 8782, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path: '/health', method: 'GET', timeout: timeoutMs }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject).on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

export async function runSupervisor({
  config = resolveBridgeConfig(),
  lockPath = config.lockPath,
  spawnChild = () => { const launch = supervisorLaunch(config); return spawn(process.execPath,launch.args,launch.options); },
  health = () => probeHealth(config.port,config.host),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxRestarts = Infinity,
  stopAfterRestarts = false,
  logger = console,
} = {}) {
  const lock = await acquireInstanceLock(lockPath);
  let stopping = false;
  let child;
  const stop = () => { stopping = true; if (child && !child.killed) child.kill('SIGTERM'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let restarts = 0;
  try {
    while (!stopping) {
      child = spawnChild();
      const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      try { await health(); logger.info?.('[bridge-supervisor] health ok'); } catch { logger.warn?.('[bridge-supervisor] bridge not healthy yet'); }
      const result = await exit;
      if (stopping) break;
      if (restarts >= maxRestarts) break;
      const delay = backoffDelay(restarts);
      restarts++;
      logger.warn?.(`[bridge-supervisor] child exited; restarting in ${delay}ms`);
      await sleep(delay);
      if (stopAfterRestarts && restarts > maxRestarts) break;
    }
  } finally {
    stop(); await lock.release();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  return { restarts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadBridgeEnvironment();
  const logPath = config.logPath;
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const logger = { info: m => { log.write(`${new Date().toISOString()} INFO ${m}\n`); }, warn: m => { log.write(`${new Date().toISOString()} WARN ${m}\n`); } };
  runSupervisor({ logger, config }).catch(error => { log.write(`${new Date().toISOString()} ERROR ${error.message}\n`); process.exitCode = 1; });
}
