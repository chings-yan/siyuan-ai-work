import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile, mkdir, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const scripts = resolve('scripts');
async function runtime(name: string) { return import(pathToFileURL(join(scripts, name)).href); }

test('public companion scripts do not contain personal machine defaults or SiYuan data writes', async () => {
  for (const name of ['bridge.mjs', 'bridge-supervisor.mjs', 'pair.mjs', 'ekko-private-file.mjs']) {
    const text = await readFile(join(scripts, name), 'utf8');
    assert.doesNotMatch(text, /E:\/[A-Za-z]|C:\/Users\/ching|SIYUAN_PLUGIN_DATA_FILE|data\/storage\/petal/);
  }
});
test('portable configuration uses its own source and user data with explicit overrides first', async () => {
  const { resolveBridgeConfig } = await runtime('bridge-config.mjs');
  const root = resolve('isolated-companion'); const home = resolve('isolated-user');
  const clean = resolveBridgeConfig({}, { projectRoot: root, home, platform: 'linux' });
  assert.equal(clean.projectRoot, root); assert.equal(clean.envFile, null);
  assert.equal(clean.tokenFile, join(home, '.local', 'share', 'siyuan-ai-collab', 'bridge-token'));
  const custom = resolveBridgeConfig({ SIYUAN_BRIDGE_PORT: '9123', SIYUAN_BRIDGE_TOKEN_FILE: join(root, 'custom') }, { projectRoot: root, home, localConfig: { SIYUAN_BRIDGE_TOKEN_FILE: join(root, 'old') } });
  assert.equal(custom.port, 9123); assert.equal(custom.tokenFile, join(root, 'custom'));
  for (const env of [{SIYUAN_BRIDGE_HOST:'0.0.0.0'}, {SIYUAN_BRIDGE_PORT:'bad'}, {SIYUAN_BRIDGE_PORT:'0'}]) assert.throws(() => resolveBridgeConfig(env), /loopback|端口/);
});
test('supervisor child and health share configured loopback host and port and its own script', async () => {
  const { supervisorLaunch } = await runtime('bridge-supervisor.mjs');
  const { resolveBridgeConfig } = await runtime('bridge-config.mjs');
  const config = resolveBridgeConfig({ SIYUAN_BRIDGE_PORT:'9123', SIYUAN_BRIDGE_HOST:'::1' }, {projectRoot: resolve('daily-companion')});
  const launch = supervisorLaunch(config, {});
  assert.equal(launch.args[0], join(config.projectRoot, 'scripts', 'bridge.mjs'));
  assert.equal(launch.options.env.SIYUAN_BRIDGE_PORT, String(config.port));
  assert.equal(launch.options.env.SIYUAN_BRIDGE_HOST, config.host);
  assert.deepEqual(launch.health, {host:config.host,port:config.port}); assert.equal(launch.options.windowsHide, true);
});
test('pair preserves existing valid token exactly and refuses blank or damaged token', async () => {
  const { setupBridgeToken } = await runtime('pair.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'bridge-portability-'));
  const file = join(dir,'token'); const original = 'a'.repeat(64)+'\n';
  const permissions = { verifyPrivatePath:async()=>{}, restrictPrivatePath:async()=>{throw new Error('existing permissions must not be changed');} };
  try {
    await writeFile(file,original); assert.equal((await setupBridgeToken({tokenFile:file,...permissions})).created,false);
    assert.equal(await readFile(file,'utf8'),original);
    for (const damaged of ['', 'invalid']) { await writeFile(file,damaged); await assert.rejects(setupBridgeToken({tokenFile:file,...permissions}), /损坏|为空/); assert.equal(await readFile(file,'utf8'),damaged); }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('pair creates no secret until permissions verified and refuses a symbolic link', async () => {
  const { setupBridgeToken } = await runtime('pair.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'bridge-portability-')); const file=join(dir,'token');
  try {
    await assert.rejects(setupBridgeToken({tokenFile:file,verifyPrivatePath:async(p:string,d:boolean)=>{if(!d)throw new Error('permission denied');},restrictPrivatePath:async(p:string,d:boolean)=>{if(!d)assert.equal(await readFile(p,'utf8'),'');}}),/permission denied/);
    await assert.rejects(readFile(file),{code:'ENOENT'});
    const target=join(dir,'target'); await mkdir(target); const link=join(dir,'linked'); await symlink(target,link,'junction');
    await assert.rejects(setupBridgeToken({tokenFile:join(link,'token'),verifyPrivatePath:async()=>{},restrictPrivatePath:async()=>{}}), /unsafe|符号/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('explicit environment file wins over private local paths and missing explicit file fails visibly', async () => {
  const { loadBridgeEnvironment } = await runtime('bridge-config.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-portability-'));
  try {
    await writeFile(join(dir,'bridge.local.json'),JSON.stringify({SIYUAN_BRIDGE_TOKEN_FILE:join(dir,'old-token')}));
    const envFile=join(dir,'explicit.env'); await writeFile(envFile,'SIYUAN_BRIDGE_TOKEN_FILE='+join(dir,'from-env')+'\nSIYUAN_BRIDGE_PORT=9224\n');
    const env={SIYUAN_BRIDGE_ENV_FILE:envFile,SIYUAN_BRIDGE_PORT:'9335'};
    const config=loadBridgeEnvironment(env,{projectRoot:dir});
    assert.equal(config.tokenFile,join(dir,'from-env')); assert.equal(config.port,9335);
    assert.throws(()=>loadBridgeEnvironment({SIYUAN_BRIDGE_ENV_FILE:join(dir,'missing')},{projectRoot:dir}), /不可读/);
    await writeFile(join(dir,'bridge.local.json'),'{}');
    assert.equal(loadBridgeEnvironment({}, {projectRoot:dir}).envFile,null);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('real platform permissions secure a new token and reject an insecure existing token', async () => {
  const { setupBridgeToken } = await runtime('pair.mjs');
  const { verifyPrivatePath } = await runtime('ekko-private-file.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-portability-'));
  try {
    const tokenFile=join(dir,'private','token');
    assert.equal((await setupBridgeToken({tokenFile})).created,true);
    await verifyPrivatePath(tokenFile,false);
    const original=await readFile(tokenFile,'utf8'); assert.match(original,/^[a-f0-9]{64}\n$/);
    assert.equal((await setupBridgeToken({tokenFile})).created,false);
    assert.equal(await readFile(tokenFile,'utf8'),original);
    const insecure=join(dir,'insecure'); await writeFile(insecure,'a'.repeat(64),{mode:0o644});
    if (process.platform !== 'win32') {
      await chmod(insecure,0o644);
      assert.equal((await stat(insecure)).mode & 0o777,0o644);
    }
    await assert.rejects(setupBridgeToken({tokenFile:insecure}),/permission|unsafe/);
    assert.equal(await readFile(insecure,'utf8'),'a'.repeat(64));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('relocated companion without configuration fails with pairing guidance and does not touch SiYuan settings', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readdir, copyFile } = await import('node:fs/promises');
  const isolatedParent=resolve('.superpowers'); await mkdir(isolatedParent,{recursive:true});
  const dir=await mkdtemp(join(isolatedParent,'bridge-portability-cli-'));
  try {
    await mkdir(join(dir,'scripts'));
    for (const name of await readdir(scripts)) if(name.endsWith('.mjs') && name !== 'package.mjs') await copyFile(join(scripts,name),join(dir,'scripts',name));
    const sentinel=join(dir,'settings'); await writeFile(sentinel,'untouched');
    const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,SIYUAN_BRIDGE_DATA_DIR:join(dir,'private'),HERMES_STUDIO_TOKEN_FILE:join(dir,'studio-token'),SIYUAN_PLUGIN_DATA_FILE:sentinel};
    const run=promisify(execFile);
    await run(process.execPath,['--input-type=module','-e',"await import('./scripts/pair.mjs')"],{cwd:dir,env,windowsHide:true,timeout:10000});
    assert.equal(await readFile(sentinel,'utf8'),'untouched');
    await assert.rejects(run(process.execPath,['scripts/bridge.mjs'],{cwd:dir,env,windowsHide:true,timeout:10000}),(error:any)=>{assert.match(error.stderr,/凭证尚未准备/);assert.equal(error.code,1);return true;});
    assert.equal(await readFile(sentinel,'utf8'),'untouched');
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('explicit source root selects that source local configuration rather than another deployment', async () => {
  const { loadBridgeEnvironment, resolveBridgeConfig } = await runtime('bridge-config.mjs');
  assert.equal(resolveBridgeConfig({}).projectRoot, resolve(scripts,'..'));
  const dir=await mkdtemp(join(tmpdir(),'bridge-portability-'));
  try {
    const chosen=join(dir,'chosen'),other=join(dir,'other'); await mkdir(chosen); await mkdir(other);
    await writeFile(join(chosen,'bridge.local.json'),JSON.stringify({SIYUAN_BRIDGE_TOKEN_FILE:join(chosen,'token')}));
    await writeFile(join(other,'bridge.local.json'),JSON.stringify({SIYUAN_BRIDGE_TOKEN_FILE:join(other,'token')}));
    assert.equal(loadBridgeEnvironment({SIYUAN_BRIDGE_PROJECT_ROOT:chosen},{projectRoot:other}).tokenFile,join(chosen,'token'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('review I1 environment-file source root uses only the selected deployment local paths', async () => {
  const {loadBridgeEnvironment,bridgeChildEnvironment}=await runtime('bridge-config.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-config-review-'));
  try {
    const a=join(dir,'a'),b=join(dir,'b');await mkdir(a);await mkdir(b);
    await writeFile(join(a,'bridge.local.json'),JSON.stringify({SIYUAN_BRIDGE_TOKEN_FILE:join(a,'token')}));
    await writeFile(join(b,'bridge.local.json'),JSON.stringify({SIYUAN_BRIDGE_TOKEN_FILE:join(b,'token')}));
    const envFile=join(dir,'select.env');await writeFile(envFile,'SIYUAN_BRIDGE_PROJECT_ROOT='+b+'\n');
    const env={SIYUAN_BRIDGE_ENV_FILE:envFile};const config=loadBridgeEnvironment(env,{projectRoot:a});
    assert.equal(config.projectRoot,b);assert.equal(config.tokenFile,join(b,'token'));
    assert.equal(bridgeChildEnvironment(config,env).SIYUAN_BRIDGE_TOKEN_FILE,join(b,'token'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('review I2 higher main-state overrides keep their derived paths together across process and file layers', async () => {
  const {loadBridgeEnvironment}=await runtime('bridge-config.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-config-review-'));
  try {
    const local={SIYUAN_BRIDGE_BINDINGS_FILE:join(dir,'old','bindings'),SIYUAN_BRIDGE_BINDINGS_V2_FILE:join(dir,'old','v2'),SIYUAN_EKKO_CONNECTION_FILE:join(dir,'old','ekko'),SIYUAN_EKKO_PENDING_DIR:join(dir,'old','pending')};
    await writeFile(join(dir,'bridge.local.json'),JSON.stringify(local));
    const explicit={SIYUAN_BRIDGE_BINDINGS_FILE:join(dir,'chosen','bindings'),SIYUAN_EKKO_CONNECTION_FILE:join(dir,'chosen','ekko')};
    const envFile=join(dir,'select.env');await writeFile(envFile,Object.entries(explicit).map(([k,v])=>k+'='+v).join('\n'));
    for(const env of [explicit,{SIYUAN_BRIDGE_ENV_FILE:envFile}]) {
      const config=loadBridgeEnvironment({...env},{projectRoot:dir});
      assert.equal(config.bindingsV2File,join(dir,'chosen','siyuan-ai-collab-bindings-v2.json'));
      assert.equal(config.pendingDirectory,join(dir,'chosen','ekko-pending-sends'));
    }
    const configured=loadBridgeEnvironment({...explicit,SIYUAN_BRIDGE_BINDINGS_V2_FILE:join(dir,'custom-v2'),SIYUAN_EKKO_PENDING_DIR:join(dir,'custom-pending')},{projectRoot:dir});
    assert.equal(configured.bindingsV2File,join(dir,'custom-v2'));assert.equal(configured.pendingDirectory,join(dir,'custom-pending'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('review I3 higher inline capability outranks lower file and same-layer file retains priority', async () => {
  const {loadBridgeEnvironment,bridgeChildEnvironment}=await runtime('bridge-config.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-config-review-'));
  try {
    await writeFile(join(dir,'bridge.local.json'),JSON.stringify({SIYUAN_BRIDGE_TOKEN_FILE:join(dir,'local-token')}));
    const file=join(dir,'select.env');await writeFile(file,'SIYUAN_BRIDGE_TOKEN_FILE='+join(dir,'file-token')+'\n');
    for(const env of [{SIYUAN_BRIDGE_TOKEN:'fictional-inline'},{SIYUAN_BRIDGE_TOKEN:'fictional-inline',SIYUAN_BRIDGE_ENV_FILE:file}]) {
      const mutable={...env};const config=loadBridgeEnvironment(mutable,{projectRoot:dir});
      assert.equal(Object.hasOwn(mutable,'SIYUAN_BRIDGE_TOKEN_FILE'),false);
      assert.equal(Object.hasOwn(bridgeChildEnvironment(config,mutable),'SIYUAN_BRIDGE_TOKEN_FILE'),false);
    }
    await writeFile(file,'SIYUAN_BRIDGE_TOKEN=fictional-inline\n');
    const fromFile={SIYUAN_BRIDGE_ENV_FILE:file};const inline=loadBridgeEnvironment(fromFile,{projectRoot:dir});
    assert.equal(Object.hasOwn(bridgeChildEnvironment(inline,fromFile),'SIYUAN_BRIDGE_TOKEN_FILE'),false);
    const both={SIYUAN_BRIDGE_TOKEN:'fictional-inline',SIYUAN_BRIDGE_TOKEN_FILE:join(dir,'explicit-token')};
    assert.equal(loadBridgeEnvironment(both,{projectRoot:dir}).tokenFile,join(dir,'explicit-token'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('review I4 relative paths remain absolute and identical before child cwd changes', async () => {
  const {loadBridgeEnvironment,bridgeChildEnvironment}=await runtime('bridge-config.mjs');
  const dir=await mkdtemp(join(tmpdir(),'bridge-config-review-'));
  try {
    const caller=join(dir,'caller'),source=join(dir,'source');await mkdir(caller);await mkdir(source);
    await writeFile(join(caller,'selected.env'),'SIYUAN_BRIDGE_PROJECT_ROOT=../source\nSIYUAN_BRIDGE_DATA_DIR=private\nSIYUAN_BRIDGE_TOKEN_FILE=private/token\nSIYUAN_BRIDGE_LOG=logs/run.log\nSIYUAN_BRIDGE_LOCK=locks/run.lock\n');
    const env={SIYUAN_BRIDGE_ENV_FILE:'selected.env'};const config=loadBridgeEnvironment(env,{projectRoot:source,cwd:caller});
    assert.equal(config.projectRoot,source);assert.equal(config.envFile,join(caller,'selected.env'));
    assert.equal(config.tokenFile,join(caller,'private','token'));assert.equal(config.logPath,join(caller,'logs','run.log'));assert.equal(config.lockPath,join(caller,'locks','run.lock'));
    const child=bridgeChildEnvironment(config,env);const reloaded=loadBridgeEnvironment(child,{projectRoot:source,cwd:source});
    assert.equal(reloaded.envFile,config.envFile);assert.equal(reloaded.tokenFile,config.tokenFile);assert.equal(reloaded.bindingsFile,config.bindingsFile);assert.equal(reloaded.pendingDirectory,config.pendingDirectory);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('review explicit derived paths in an environment file survive a process primary-path override', async () => {
  const {loadBridgeEnvironment}=await runtime('bridge-config.mjs');const dir=await mkdtemp(join(tmpdir(),'bridge-config-review-'));
  try {
    await writeFile(join(dir,'bridge.local.json'),JSON.stringify({SIYUAN_BRIDGE_BINDINGS_V2_FILE:join(dir,'local-v2'),SIYUAN_EKKO_PENDING_DIR:join(dir,'local-pending')}));
    const file=join(dir,'chosen.env');await writeFile(file,'SIYUAN_BRIDGE_BINDINGS_V2_FILE='+join(dir,'file-v2')+'\nSIYUAN_EKKO_PENDING_DIR='+join(dir,'file-pending')+'\n');
    const config=loadBridgeEnvironment({SIYUAN_BRIDGE_ENV_FILE:file,SIYUAN_BRIDGE_BINDINGS_FILE:join(dir,'process','bindings'),SIYUAN_EKKO_CONNECTION_FILE:join(dir,'process','ekko')},{projectRoot:dir});
    assert.equal(config.bindingsV2File,join(dir,'file-v2'));assert.equal(config.pendingDirectory,join(dir,'file-pending'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
