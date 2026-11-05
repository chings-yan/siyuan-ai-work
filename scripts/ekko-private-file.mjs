import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, lstat, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { resolveBridgeConfig } from './bridge-config.mjs';

export function ekkoConnectionFile(env = process.env) {
  return resolveBridgeConfig(env).ekkoFile;
}

function runPowerShell(script, path) {
  const setup = `Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop;`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', setup + script], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, SIYUAN_EKKO_ACL_PATH: path } });
  if (result.status !== 0 || result.error) throw new Error('EKKO private file permission check failed');
  return result.stdout.trim();
}

async function checkRegularPath(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('EKKO private file path is unsafe');
  return info;
}

export async function verifyPrivatePath(path, directory) {
  const info = await checkRegularPath(path, directory);
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop';$p=$env:SIYUAN_EKKO_ACL_PATH;$a=Get-Acl -LiteralPath $p;$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($a.Access | Where-Object { $_.AccessControlType -eq 'Allow' } | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value });if($a.AreAccessRulesProtected -ne $true -or $allowed.Count -eq 0 -or @($allowed | Where-Object { $_ -ne $me -and $_ -ne 'S-1-5-18' }).Count -ne 0 -or $allowed -notcontains $me){exit 3};'ok'`;
    if (runPowerShell(script, path) !== 'ok') throw new Error('EKKO private file permission check failed');
  } else if ((info.mode & 0o077) !== 0) {
    throw new Error('EKKO private file permission check failed');
  }
}

export async function restrictPrivatePath(path, directory) {
  await checkRegularPath(path, directory);
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference='Stop';$p=$env:SIYUAN_EKKO_ACL_PATH;$a=Get-Acl -LiteralPath $p;$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)};$inherit=if((Get-Item -LiteralPath $p).PSIsContainer){[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit}else{[System.Security.AccessControl.InheritanceFlags]::None};$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($me,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($rule);Set-Acl -LiteralPath $p -AclObject $a`;
    runPowerShell(script, path);
  } else {
    await chmod(path, directory ? 0o700 : 0o600);
  }
  await verifyPrivatePath(path, directory);
}

function validateConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.connectionId !== 'string' || !value.connectionId ||
      typeof value.baseUrl !== 'string' || !value.baseUrl ||
      typeof value.deviceId !== 'string' || !value.deviceId ||
      !Number.isSafeInteger(value.accountUserId) || value.accountUserId <= 0 ||
      typeof value.accountName !== 'string' || !value.accountName ||
      !Number.isSafeInteger(value.appConnectionId) || value.appConnectionId <= 0 ||
      typeof value.token !== 'string' || !value.token ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) {
    throw new Error('EKKO private connection data is invalid; restore from backup');
  }
  return value;
}

function approvedConnection(value) {
  const { connectionId, baseUrl, deviceId, accountUserId, accountName, appConnectionId, token, expiresAt } = validateConnection(value);
  return { connectionId, baseUrl, deviceId, accountUserId, accountName, appConnectionId, token, expiresAt };
}

export function createEkkoConnectionStore({ filePath = ekkoConnectionFile() } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('EKKO private file path is required');
  return {
    async read() {
      try { await verifyPrivatePath(filePath, false); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
      try { return approvedConnection(JSON.parse(await readFile(filePath, 'utf8'))); }
      catch { throw new Error('EKKO private connection data is invalid; restore from backup'); }
    },
    async write(connection) {
      const record = approvedConnection(connection);
      const parent = dirname(filePath);
      await mkdir(parent, { recursive: true });
      const stage = await mkdtemp(join(parent, '.ekko-private-'));
      try {
        await restrictPrivatePath(stage, true);
        const temp = join(stage, `${randomUUID()}.json`);
        await writeFile(temp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await restrictPrivatePath(temp, false);
        await rename(temp, filePath);
        await verifyPrivatePath(filePath, false);
      } catch (error) {
        throw new Error('EKKO private connection could not be saved securely', { cause: error });
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
  };
}
