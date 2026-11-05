import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { TestContext } from 'node:test';
// @ts-expect-error runtime ESM helper has no declaration
import { fetchStudioSessionsPaginated } from '../scripts/studio-client.mjs';
// @ts-expect-error runtime ESM helper has no declaration
import { createBridgeServer, loadStudioToken, studioTokenPath } from '../scripts/bridge.mjs';

const ROOT = '20260826094850-kronins';

async function listenForFetch(t: Pick<TestContext,'after'>, server: Server, probe: (url:string)=>Promise<Response> = url=>fetch(url,{signal:AbortSignal.timeout(2000)})) {
  const stop=async()=>{
    server.closeAllConnections();
    if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  };
  t.after(stop);
  for(let attempt=0;attempt<5;attempt++) {
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
    });
    const port=(server.address() as {port:number}).port;
    try {
      // Windows may allocate a port that fetch forbids; probe before business I/O.
      const response=await probe(`http://127.0.0.1:${port}/health`);
      assert.equal(response.status,200);await response.arrayBuffer();return port;
    } catch(error) {
      await stop();
      if(!(error instanceof TypeError && error.cause instanceof Error && error.cause.message==='bad port') || attempt===4)throw error;
    }
  }
  throw new Error('No fetchable local fixture port');
}

test('Studio HTTP fixture recovers from a real fetch bad-port rejection', async t => {
  const server=createServer((_req,res)=>res.end('healthy'));
  t.after(()=>server.close());
  let probes=0;
  const port=await listenForFetch(t,server,url=>fetch(++probes===1?'http://127.0.0.1:1/health':url));
  assert.ok(probes>=2 && probes<=5);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(),'healthy');
});

test('Studio HTTP fixture exposes other fetch failures and releases its listener', async t => {
  const server=createServer((_req,res)=>res.end('healthy'));
  t.after(()=>server.close());
  const failure=new TypeError('fetch failed',{cause:new Error('connection failed')});let probes=0;
  await assert.rejects(listenForFetch(t,server,async()=>{probes++;throw failure;}),error=>error===failure);
  assert.equal(probes,1);assert.equal(server.listening,false);
});

test('Studio HTTP fixture bounds bad-port retries and releases the final listener', async t => {
  const server=createServer((_req,res)=>res.end('healthy'));
  t.after(()=>server.close());
  let probes=0;
  await assert.rejects(listenForFetch(t,server,()=>{probes++;return fetch('http://127.0.0.1:1/health');}),error=>error instanceof TypeError && error.cause instanceof Error && error.cause.message==='bad port');
  assert.equal(probes,5);assert.equal(server.listening,false);
});

test('Studio HTTP fixture registers cleanup before the test body can fail', async t => {
  const server=createServer((_req,res)=>res.end('healthy'));
  t.after(()=>server.close());
  const cleanups:(()=>unknown)[]=[];
  await listenForFetch({after:fn=>{cleanups.push(fn as ()=>unknown);}},server);
  const failure=new Error('simulated later assertion failure');
  await assert.rejects(async()=>{try{throw failure;}finally{for(const cleanup of cleanups)await cleanup();}},error=>error===failure);
  assert.equal(server.listening,false);
});

test('studio metadata route reads default sessions without message bodies', async (t) => {
  const calls: Array<[string | URL, RequestInit]> = [];
  const { server }=createBridgeServer({ capability:'c'.repeat(64), studioToken:'studio-test', studioBase:'http://studio', fetchImpl:async (url: string | URL, init: RequestInit = {})=>{calls.push([url,init]); return new Response(JSON.stringify({sessions:[{id:'s1',profile:'default',title:'T',preview:'P',message_count:2,messages:[{content:'body'}]},{id:'x',profile:'other'}]}),{status:200,headers:{'content-type':'application/json'}});}, bindingsFile:join(tmpdir(), `studio-metadata-${process.pid}.json`) });
  const port=await listenForFetch(t,server);
  const response=await fetch(`http://127.0.0.1:${port}/studio/sessions`,{headers:{'X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT,'Origin':'http://127.0.0.1:6806'}});
  assert.equal(response.status,200); assert.deepEqual(await response.json(),{data:[{id:'s1',title:'T',preview:'P',last_active:null,message_count:2,source:'studio',profile:'default'}]});
  assert.deepEqual(calls.map(([url]) => String(url)), ['http://studio/api/studio/sessions', 'http://studio/api/studio/sessions/hermes?offset=0&limit=200']);
});

test('Studio token defaults to the profile default model-run token and supports an env override', async () => {
  assert.equal(studioTokenPath({}), join(homedir(), '.hermes-web-ui', 'profiles', 'default', '.model-run-token'));
  const dir = await mkdtemp(join(tmpdir(), 'studio-token-'));
  const file = join(dir, 'token');
  await writeFile(file, 'override-secret\n', 'utf8');
  assert.equal(studioTokenPath({ HERMES_STUDIO_TOKEN_FILE: file }), file);
  assert.equal(loadStudioToken({ HERMES_STUDIO_TOKEN_FILE: file }), 'override-secret');
  await rm(dir, { recursive: true, force: true });
});

test('Studio HTTP requests read the latest token and retry one 401 without exposing it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-token-'));
  const file = join(dir, 'token');
  await writeFile(file, 'first-secret', 'utf8');
  const calls: Array<[string | URL, RequestInit]> = [];
  let attempt = 0;
  const { server } = createBridgeServer({ capability:'c'.repeat(64), studioBase:'http://studio', bindingsFile:join(dir, 'bindings.json'), fetchImpl:async (url: string | URL, init: RequestInit = {}) => {
    calls.push([url, init]);
    if (++attempt === 1) { await writeFile(file, 'second-secret', 'utf8'); return new Response('{}', { status:401 }); }
    return new Response(JSON.stringify({ sessions: [] }), { status:200, headers:{'content-type':'application/json'} });
  }});
  const previous = process.env.HERMES_STUDIO_TOKEN_FILE;
  process.env.HERMES_STUDIO_TOKEN_FILE = file;
  try {
    const port = await listenForFetch(t,server);
    const response = await fetch(`http://127.0.0.1:${port}/studio/sessions`, { headers:{'X-Siyuan-Collab-Token':'c'.repeat(64), 'X-Siyuan-Document-Root':ROOT} });
    assert.equal(response.status, 200);
    assert.deepEqual(calls.map(([, init]) => (init.headers as Record<string,string>).Authorization), ['Bearer first-secret', 'Bearer second-secret', 'Bearer second-secret']);
    assert.equal(JSON.stringify(await response.json()).includes('first-secret'), false);
  } finally { if (previous === undefined) delete process.env.HERMES_STUDIO_TOKEN_FILE; else process.env.HERMES_STUDIO_TOKEN_FILE = previous; await rm(dir, { recursive:true, force:true }); }
});

test('Studio metadata does not turn upstream 401 into an empty list', async (t) => {
  const { server } = createBridgeServer({ capability:'c'.repeat(64), studioBase:'http://studio', studioToken:'bad', bindingsFile:join(tmpdir(), `studio-401-${process.pid}.json`), fetchImpl:async()=>new Response('{}',{status:401}) });
  const port=await listenForFetch(t,server);
  const response=await fetch(`http://127.0.0.1:${port}/studio/sessions`,{headers:{'X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT}});
  assert.equal(response.status,500); assert.notDeepEqual(await response.json(),{data:[]});
});

test('studio sessions fetches all pages, deduplicates, and returns safe default metadata', async (t) => {
  const calls: string[] = [];
  const pages = [
    { sessions: [{ id:'s1', profile:'default', title:'First', preview:'P1', message_count:1, messages:[{content:'secret'}] }], hasMore:true, offset:0, limit:200 },
    { sessions: [{ id:'s1', profile:'default', title:'Duplicate', preview:'ignored' }, { id:'s201', profile:'default', title:'Second', preview:'P2', message_count:3, extra:'ignored' }], hasMore:false, offset:200, limit:200 },
  ];
  const { server } = createBridgeServer({ capability:'c'.repeat(64), studioToken:'studio-test', studioBase:'http://studio', bindingsFile:join(tmpdir(), `studio-pages-${process.pid}.json`), fetchImpl:async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/studio/sessions')) return new Response(JSON.stringify({ sessions:[] }), { status:200, headers:{'content-type':'application/json'} });
    return new Response(JSON.stringify(pages[calls.filter(call => call.includes('/hermes?')).length - 1]), { status:200, headers:{'content-type':'application/json'} });
  }});
  const port=await listenForFetch(t,server);
  const response=await fetch(`http://127.0.0.1:${port}/studio/sessions`,{headers:{'X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT} });
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(), { data:[
    {id:'s1',title:'First',preview:'P1',last_active:null,message_count:1,source:'studio',profile:'default'},
    {id:'s201',title:'Second',preview:'P2',last_active:null,message_count:3,source:'studio',profile:'default'},
  ]});
  assert.deepEqual(calls, ['http://studio/api/studio/sessions', 'http://studio/api/studio/sessions/hermes?offset=0&limit=200', 'http://studio/api/studio/sessions/hermes?offset=200&limit=200']);
});

test('Studio index metadata wins duplicate canonical rows before default-profile filtering', async (t) => {
  const calls: string[] = [];
  const { server } = createBridgeServer({ capability:'c'.repeat(64), studioToken:'studio-test', studioBase:'http://studio', bindingsFile:join(tmpdir(), `studio-index-priority-${process.pid}.json`), fetchImpl:async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/studio/sessions')) return new Response(JSON.stringify({ sessions:[{ id:'same', profile:'default', title:'Index title', preview:'Index preview' }] }), { status:200, headers:{'content-type':'application/json'} });
    return new Response(JSON.stringify({ sessions:[{ id:'same', profile:'default', title:'Canonical title' }, { id:'other', profile:'other', title:'Hidden' }], hasMore:false, offset:0, limit:200 }), { status:200, headers:{'content-type':'application/json'} });
  }});
  const port=await listenForFetch(t,server);
  const response=await fetch(`http://127.0.0.1:${port}/studio/sessions`,{headers:{'X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT}});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(), { data:[{id:'same',title:'Index title',preview:'Index preview',last_active:null,message_count:0,source:'studio',profile:'default'}] });
  assert.deepEqual(calls, ['http://studio/api/studio/sessions', 'http://studio/api/studio/sessions/hermes?offset=0&limit=200']);
});

test('Studio canonical metadata non-2xx fails the picker request instead of returning partial index data', async (t) => {
  const { server } = createBridgeServer({ capability:'c'.repeat(64), studioToken:'studio-test', studioBase:'http://studio', bindingsFile:join(tmpdir(), `studio-canonical-error-${process.pid}.json`), fetchImpl:async (url: string | URL) => String(url).endsWith('/api/studio/sessions')
    ? new Response(JSON.stringify({ sessions:[{ id:'index-only', profile:'default', title:'Index' }] }), { status:200, headers:{'content-type':'application/json'} })
    : new Response('{}', { status:503, headers:{'content-type':'application/json'} }) });
  const port=await listenForFetch(t,server);
  const response=await fetch(`http://127.0.0.1:${port}/studio/sessions`,{headers:{'X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT}});
  assert.equal(response.status,500);
  assert.notDeepEqual(await response.json(), { data:[{ id:'index-only' }] });
});

test('studio bind finds a default session on a later page', async (t) => {
  const calls: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'studio-bind-pages-'));
  const { server }=createBridgeServer({ capability:'c'.repeat(64), studioToken:'studio-test', studioBase:'http://studio', bindingsFile:join(dir, 'bindings.json'), fetchImpl:async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/studio/sessions')) return new Response(JSON.stringify({sessions:[]}),{status:200,headers:{'content-type':'application/json'}});
    const page = String(url).includes('offset=0') ? {sessions:[],hasMore:true,offset:0,limit:200} : {sessions:[{id:'later',profile:'default',title:'Later',preview:'x'}],hasMore:false,offset:200,limit:200};
    return new Response(JSON.stringify(page),{status:200,headers:{'content-type':'application/json'}});
  }});
  t.after(async () => { await rm(dir, { recursive:true, force:true }); });
  const port=await listenForFetch(t,server);
  const response=await fetch(`http://127.0.0.1:${port}/studio/bind`,{method:'POST',headers:{'Content-Type':'application/json','X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT,'Origin':'http://127.0.0.1:6806'},body:JSON.stringify({session_id:'later'})});
  assert.equal(response.status,200); assert.equal((await response.json()).binding.id,'later');
  assert.deepEqual(calls, ['http://studio/api/studio/sessions', 'http://studio/api/studio/sessions/hermes?offset=0&limit=200', 'http://studio/api/studio/sessions/hermes?offset=200&limit=200']);
});

test('studio session pagination enforces a bounded page count', async () => {
  let calls = 0;
  await assert.rejects(() => fetchStudioSessionsPaginated({ maxPages:2, fetchPage: async () => { calls++; return { sessions:[], hasMore:true, offset:(calls - 1) * 200, limit:200 }; } }), /maximum page limit/);
  assert.equal(calls, 2);
});

test('studio session pagination rejects non-advancing offsets', async () => {
  await assert.rejects(() => fetchStudioSessionsPaginated({ fetchPage: async () => ({ sessions:[], hasMore:true, offset:0, limit:0 }) }), /invalid offset/);
});

test('studio bind can find an imported session that exists only in the Studio index', async (t) => {
  const calls: string[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'studio-bind-index-'));
  const { server } = createBridgeServer({ capability:'c'.repeat(64), studioToken:'studio-test', studioBase:'http://studio', bindingsFile:join(dir, 'bindings.json'), fetchImpl:async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/studio/sessions')) return new Response(JSON.stringify({ sessions:[{ id:'api_1787712781_b616a8dc', profile:'default', title:'Imported', preview:'secret-free', message_count:6, messages:[{content:'must not leak'}] }] }), { status:200, headers:{'content-type':'application/json'} });
    return new Response(JSON.stringify({ sessions:[], hasMore:false, offset:0, limit:200 }), { status:200, headers:{'content-type':'application/json'} });
  }});
  t.after(async () => { await rm(dir, { recursive:true, force:true }); });
  const port=await listenForFetch(t,server);
  const response=await fetch(`http://127.0.0.1:${port}/studio/bind`,{method:'POST',headers:{'Content-Type':'application/json','X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT},body:JSON.stringify({session_id:'api_1787712781_b616a8dc'})});
  assert.equal(response.status,200); assert.equal((await response.json()).binding.id,'api_1787712781_b616a8dc');
  assert.deepEqual(calls, ['http://studio/api/studio/sessions', 'http://studio/api/studio/sessions/hermes?offset=0&limit=200']);
});

test('studio bind rejects IDs absent from the live default list', async (t) => {
  const { server }=createBridgeServer({ capability:'c'.repeat(64), studioToken:'studio-test', studioBase:'http://studio', fetchImpl:async()=>new Response(JSON.stringify({sessions:[]}),{status:200}), bindingsFile:join(tmpdir(), `studio-missing-${process.pid}.json`) });
  const port=await listenForFetch(t,server);
  const response=await fetch(`http://127.0.0.1:${port}/studio/bind`,{method:'POST',headers:{'Content-Type':'application/json','X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT,'Origin':'http://127.0.0.1:6806'},body:JSON.stringify({session_id:'missing'})});
  assert.equal(response.status,404); assert.equal((await response.json()).error.code,'studio_session_not_found');
});

test('locally created Studio ID with colons keeps its raw binding for history and stream', async t => {
  const dir=await mkdtemp(join(tmpdir(),'studio-colon-id-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const id=`siyuan:${ROOT}:new-1`,bindingsFile=join(dir,'bindings.json');
  await writeFile(bindingsFile,JSON.stringify({[`${ROOT}:${id}`]:{id,title:'新对话',documentRootId:ROOT,source:'studio',profile:'default',pending:false}}));
  const calls:string[]=[];let runs=0;
  const {server}=createBridgeServer({capability:'c'.repeat(64),studioToken:'studio-test',studioBase:'http://studio',bindingsFile,
    fetchImpl:async (url:string|URL)=>{calls.push(String(url));assert.equal(String(url),`http://studio/api/studio/sessions/conversations/${encodeURIComponent(id)}/messages/paginated?offset=0&limit=200`);return Response.json({messages:[{id:'m1',role:'user',content:'已保存'}],total:1,offset:0,limit:200,hasMore:false});},
    studioRun:async ({payload,onEvent}:any)=>{runs++;assert.equal(payload.session_id,id);assert.equal(payload.input,'新消息');onEvent('message.delta',{delta:'收到'});onEvent('run.completed',{content:'收到'});return {content:'收到'};}
  });
  const port=await listenForFetch(t,server),base=`http://127.0.0.1:${port}/sessions/${encodeURIComponent(id)}`;
  const headers={'X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':ROOT};
  const history=await fetch(`${base}/messages`,{headers});
  assert.equal(history.status,200);assert.deepEqual((await history.json()).data.map((row:any)=>row.role),['user']);
  const stream=await fetch(`${base}/chat/stream`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({message:'新消息'})});
  assert.equal(stream.status,200);assert.match(await stream.text(),/run\.completed/);
  assert.equal(runs,1);assert.equal(calls.length,1,'colon ID must never fall through to the old API');
});
