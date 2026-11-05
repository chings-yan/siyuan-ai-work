import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { mkdir, open, readFile, stat, lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect as netConnect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { probeServe } from './hermes-connections.mjs';
import { createGatewayClient } from './hermes-gateway-client.mjs';

const execFileAsync = promisify(execFile);
const noopLogger = { info() {}, warn() {} };
export const defaultTokenFile = () => join(process.env.HERMES_HOME || join(homedir(), '.hermes'), 'siyuan-ai-collab', 'serve-token');

// Inspect effective Windows ACL principals; an unknown readable allow entry fails closed.
const checkAcl = String.raw`$ErrorActionPreference='Stop'; $acl=[IO.File]::GetAccessControl($args[0]); $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $allowed=@($me,'S-1-5-18','S-1-5-32-544'); $read=[int][Security.AccessControl.FileSystemRights]::Read; foreach($rule in $acl.Access){ if($rule.AccessControlType -ne 'Allow'){continue}; $sid=$rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if((([int]$rule.FileSystemRights -band $read) -ne 0) -and ($allowed -notcontains $sid)){Write-Output 'INSECURE'; exit 0} }; Write-Output 'PRIVATE'`;
const setAcl = String.raw`$ErrorActionPreference='Stop'; $path=$args[0]; $acl=[IO.File]::GetAccessControl($path); $acl.SetAccessRuleProtection($true,$false); foreach($rule in @($acl.Access)){[void]$acl.RemoveAccessRuleAll($rule)}; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=New-Object Security.AccessControl.FileSystemAccessRule($me,'FullControl','Allow'); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl($path,$acl)`;
const checkDirectoryAcl = checkAcl.replace('[IO.File]::GetAccessControl', '[IO.Directory]::GetAccessControl');
const setDirectoryAcl = setAcl.replace('[IO.File]::GetAccessControl', '[IO.Directory]::GetAccessControl').replace('[IO.File]::SetAccessControl', '[IO.Directory]::SetAccessControl');
async function powershell(script, path) {
  const source = `$taskTokenPath='${path.replaceAll("'", "''")}'; ${script.replaceAll('$args[0]', '$taskTokenPath')}`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 10_000 });
  return stdout.trim();
}
export async function tokenFileIsPrivate(tokenFile) {
  try {
    if ((await lstat(tokenFile)).isSymbolicLink()) return false;
    const details = await stat(tokenFile);
    if (!details.isFile()) return false;
    if (process.platform === 'win32') return await powershell(checkAcl, tokenFile) === 'PRIVATE';
    return (details.mode & 0o077) === 0;
  } catch { return false; }
}
async function setTokenFilePrivate(tokenFile) {
  if (process.platform === 'win32') await powershell(setAcl, tokenFile);
}
export async function directoryIsPrivate(directory) {
  try {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) return false;
    if (process.platform === 'win32') return await powershell(checkDirectoryAcl, directory) === 'PRIVATE';
    return (details.mode & 0o077) === 0;
  } catch { return false; }
}
async function setDirectoryPrivate(directory) {
  if (process.platform === 'win32') await powershell(setDirectoryAcl, directory);
}

export async function setupServeToken({ tokenFile = defaultTokenFile(), setTokenFilePrivate: harden = setTokenFilePrivate,
  tokenFileIsPrivate: isPrivate = tokenFileIsPrivate, setDirectoryPrivate: hardenDirectory = setDirectoryPrivate,
  directoryIsPrivate: isDirectoryPrivate = directoryIsPrivate, removeCreatedToken = unlink, logger = noopLogger } = {}) {
  const directory = dirname(tokenFile);
  let directoryCreated = false;
  try {
    await lstat(directory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    directoryCreated = Boolean(await mkdir(directory, { recursive: true, mode: 0o700 }));
  }
  if (directoryCreated) await hardenDirectory(directory);
  if (!await isDirectoryPrivate(directory)) throw new Error('Serve 令牌目录权限不安全；请使用私有目录');

  let file;
  try { file = await open(tokenFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (!await isPrivate(tokenFile)) throw new Error('已有 Serve 令牌文件权限不安全；不会覆盖');
    const existing = await readFile(tokenFile, 'utf8');
    if (!existing.trim()) throw new Error('已有 Serve 令牌文件为空；不会覆盖');
    logger.info(`Serve 令牌文件已存在：${tokenFile}`);
    return { created: false, tokenFile };
  }
  try {
    await harden(tokenFile);
    if (!await isPrivate(tokenFile)) throw new Error('Serve 令牌文件权限不安全；不会写入');
    await file.writeFile(randomBytes(32).toString('hex'));
    await file.sync();
    await file.close();
  } catch (error) {
    let closeError;
    try { await file.close(); } catch (failure) { closeError = failure; }
    try { await removeCreatedToken(tokenFile); }
    catch (cleanupError) { throw new Error(`Serve 新令牌清理失败；原故障：${error.message}；清理故障：${cleanupError.message}${closeError ? `；关闭故障：${closeError.message}` : ''}`, { cause: error }); }
    if (closeError) throw new Error(`Serve 新令牌文件关闭失败；原故障：${error.message}；关闭故障：${closeError.message}`, { cause: error });
    throw error;
  }
  logger.info(`Serve 令牌文件已建立：${tokenFile}`);
  return { created: true, tokenFile };
}

export async function portOccupied(port) {
  return new Promise(resolve => {
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.setTimeout(1500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => { socket.destroy(); resolve(error?.code !== 'ECONNREFUSED'); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
}

export async function probeLocalServe({ port, tokenFile }) {
  return probeServe({ baseUrl: `http://127.0.0.1:${port}`, profile: 'default', tokenFile }, {
    rpcProbe: async (connection, { method, token, profile }) => {
      const gateway = createGatewayClient({ baseUrl: connection.baseUrl, token, profile, timeoutMs: 5000 });
      try { return await (method === 'gateway.ping' ? gateway.ping() : gateway.list()); }
      finally { gateway.close(); }
    },
  });
}

export async function launchHermesServe({ hermesCommand, port, tokenFile, expectedInstallId,
  probe = probeLocalServe, spawnChild = spawn, logger = noopLogger,
  tokenFileIsPrivate: isPrivate = tokenFileIsPrivate, portOccupied: isOccupied = portOccupied } = {}) {
  if (typeof hermesCommand !== 'string' || !hermesCommand.trim()) throw new Error('Hermes 命令未配置');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Serve 端口无效');
  if (typeof tokenFile !== 'string' || !tokenFile.trim()) throw new Error('Serve 令牌文件未配置');
  let token;
  try { token = (await readFile(tokenFile, 'utf8')).trim(); } catch { throw new Error('Serve 令牌缺失或不可读'); }
  if (!token) throw new Error('Serve 令牌缺失');
  if (!await isPrivate(tokenFile)) throw new Error('Serve 令牌文件权限不安全；请修复 ACL');
  if (await isOccupied(port)) {
    if (!expectedInstallId) throw new Error('端口已占用且缺少预期安装身份，拒绝附着');
    const status = await probe({ port, tokenFile });
    if (status?.state !== 'ready' || status.installId !== expectedInstallId) throw new Error('端口已占用，服务身份或认证能力不匹配');
    logger.info(`Serve 已连接：127.0.0.1:${port}`);
    return { owned: false };
  }
  const child = spawnChild(hermesCommand, ['serve', '--host', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token }, windowsHide: true, stdio: 'ignore',
  });
  child?.once?.('error', () => {});
  if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error('Hermes Serve 子进程未成功启动');
  logger.info(`Serve 已启动：127.0.0.1:${port}，PID ${child.pid}`);
  return { owned: true, pid: child.pid };
}

function startupExitError(exit) {
  return exit?.code === 78
    ? new Error('Serve 配置拒绝（退出 78）；请核对固定端点与现有后端配置')
    : new Error('Serve 子进程在健康验证前退出，启动失败');
}

// This is the CLI readiness check itself; it only observes the exact owned child.
export async function verifyOwnedChild({ child, childExit, probe, expectedInstallId, logger = noopLogger, timeoutMs = 15_000, pollMs = 500 }) {
  let stopped = false;
  let timer;
  let pollTimer;
  const exited = childExit.then(exit => { stopped = true; throw startupExitError(exit); });
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { stopped = true; child.kill(); reject(new Error('Serve 启动后健康检查超时')); }, timeoutMs);
  });
  const check = async () => {
    while (!stopped) {
      if (child.exitCode != null || child.signalCode != null) throw startupExitError({ code: child.exitCode });
      const status = await probe();
      if (stopped) return false;
      if (child.exitCode != null || child.signalCode != null) throw startupExitError({ code: child.exitCode });
      if (status?.state === 'ready') {
        if (expectedInstallId && status.installId !== expectedInstallId) {
          child.kill();
          throw new Error('Serve 启动后安装身份不匹配');
        }
        logger.info('Serve 健康检查通过');
        return true;
      }
      await new Promise(resolve => { pollTimer = setTimeout(resolve, pollMs); });
    }
    return false;
  };
  try { return await Promise.race([check(), exited, deadline]); }
  finally { stopped = true; clearTimeout(timer); clearTimeout(pollTimer); }
}

export async function runOwnedServe({ launch, waitForExit, verifyOwned, shouldContinue = () => true }) {
  while (shouldContinue()) {
    const result = await launch();
    if (!result.owned) return result;
    if (typeof verifyOwned !== 'function' || await verifyOwned(result) !== true) throw new Error('Serve 启动未通过健康验证');
    const exit = await waitForExit(result.pid);
    if (exit?.code === 78) throw startupExitError(exit);
  }
}

async function main() {
  const logger = { info: line => console.log(line), warn: line => console.error(line) };
  if (process.argv.includes('--setup')) {
    await setupServeToken({ tokenFile: process.env.HERMES_SERVE_TOKEN_FILE || defaultTokenFile(), logger });
    return;
  }
  const hermesCommand = process.env.HERMES_SERVE_COMMAND;
  const port = Number(process.env.HERMES_SERVE_PORT || 9119);
  const tokenFile = process.env.HERMES_SERVE_TOKEN_FILE;
  const expectedInstallId = process.env.HERMES_SERVE_EXPECTED_INSTALL_ID;
  let ownedChild;
  let childExit;
  await runOwnedServe({
    launch: () => launchHermesServe({ hermesCommand, port, tokenFile, expectedInstallId, logger,
      spawnChild: (...args) => {
        ownedChild = spawn(...args);
        childExit = new Promise(resolve => {
          ownedChild.once('exit', (code, signal) => resolve({ code, signal }));
          ownedChild.once('error', () => resolve({ failed: true }));
        });
        return ownedChild;
      },
    }),
    verifyOwned: () => verifyOwnedChild({ child: ownedChild, childExit,
      probe: () => probeLocalServe({ port, tokenFile }), expectedInstallId, logger }),
    waitForExit: async () => {
      // This promise belongs to the exact child created above, so PID reuse cannot affect ownership.
      const exit = await childExit;
      ownedChild = undefined;
      if (exit?.code !== 78) await new Promise(resolve => setTimeout(resolve, 1000));
      return exit;
    },
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { console.error(`Serve 启动失败：${error.message}`); process.exitCode = 1; });
}
