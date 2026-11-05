import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, mkdir, lstat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBridgeConfig, loadBridgeEnvironment } from './bridge-config.mjs';
import { verifyPrivatePath, restrictPrivatePath } from './ekko-private-file.mjs';

async function checkAncestors(path) {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Bridge token path is unsafe: 符号链接'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

export async function setupBridgeToken({ tokenFile = resolveBridgeConfig().tokenFile, verifyPrivatePath: verify = verifyPrivatePath, restrictPrivatePath: restrict = restrictPrivatePath } = {}) {
  await checkAncestors(tokenFile);
  const directory = dirname(tokenFile);
  let createdDirectory = false;
  try { await lstat(directory); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; createdDirectory = Boolean(await mkdir(directory,{recursive:true,mode:0o700})); }
  if (createdDirectory) await restrict(directory,true);
  await verify(directory,true);
  let handle;
  try { handle = await open(tokenFile,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,0o600); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await verify(tokenFile,false);
    const existing = (await readFile(tokenFile,'utf8')).trim();
    if (!/^[a-f0-9]{64,}$/.test(existing)) throw new Error('已有 Bridge 令牌为空或损坏；不会覆盖，请人工核对');
    return {created:false,tokenFile};
  }
  try {
    await restrict(tokenFile,false);
    await verify(tokenFile,false);
    await handle.writeFile(randomBytes(32).toString('hex')+'\n'); await handle.sync(); await handle.close();
  } catch (error) {
    let closeFailure; try { await handle.close(); } catch (failure) { closeFailure = failure; }
    try { await unlink(tokenFile); } catch { throw new Error('Bridge 新令牌清理失败；保留空文件供人工核对', {cause:error}); }
    if (closeFailure) throw new Error('Bridge 新令牌关闭失败', {cause:error});
    throw error;
  }
  return {created:true,tokenFile};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = loadBridgeEnvironment();
    const result = await setupBridgeToken({tokenFile:config.tokenFile});
    console.log(JSON.stringify({created:result.created,tokenFile:result.tokenFile,capability:'ready',next:'从本机私有文件手动复制凭证到插件设置；核对并保存'}));
  } catch { console.error('Bridge 配对准备失败：请核对配置路径、文件内容和私有权限；已有文件不会覆盖。'); process.exitCode=1; }
}
