import test from 'node:test';
import {studioProjectionFixture,partialStudioBinding} from './studio-projection-fixture.ts';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error runtime ESM
import {createBridgeServer} from '../scripts/bridge.mjs';
const A='20260923123456-abcdefg',B='20260923123457-abcdefg',CAP='b'.repeat(64);
async function fixture(kind='serve'){
 const dir=await mkdtemp(join(tmpdir(),'shared-bindings-')),legacy=join(dir,'legacy.json'),v2=join(dir,'v2.json'),tokenFile=join(dir,'token');
 await writeFile(tokenFile,'synthetic-token');await writeFile(legacy,'{}');
 const state={install:'install-1',title:'Synthetic',offline:false};
 const {server}=createBridgeServer({capability:CAP,bindingsFile:legacy,bindingsV2File:v2,studioToken:'synthetic',connections:{defaultConnectionId:'selected',connections:[{id:'selected',kind,profile:'default',baseUrl:'http://127.0.0.1:9199',tokenFile},{id:'offline',kind:'serve',profile:'default',baseUrl:'http://127.0.0.1:9198',tokenFile}]},
 fetchImpl:async(url:any)=>String(url).includes('/api/status')?Response.json({install_id:state.install}):Response.json({sessions:[{id:'remote',profile:'default',title:state.title}],hasMore:false}),
 gatewayFactory:({connection}:any)=>({ping:async()=>{if(connection.id==='offline'&&state.offline)throw Error('synthetic offline');return {ok:true};},list:async()=>({sessions:[{id:'remote',title:state.title}]}),history:async()=>({messages:[]}),close(){}})});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const call=(path:string,root=A,body?:any)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Siyuan-Collab-Token':CAP,'X-Siyuan-Document-Root':root},...(body?{body:JSON.stringify(body)}:{})});
 const bind=(id:string,root=A,connection='selected')=>call('/chats/bind',root,{chat_id:id,connection_id:connection,stored_session_id:'remote',confirm:true});
 return {call,bind,state,legacy,v2,close:async()=>{await new Promise<void>(done=>server.close(()=>done()));await rm(dir,{recursive:true,force:true});}};
}
for(const kind of ['serve','studio'])test(`${kind} shares exact session across roots and atomically deduplicates within a root`,async()=>{
 const f=await fixture(kind);try{
  assert.equal((await f.bind('a')).status,200);const b=await f.bind('b',B);assert.equal(b.status,200);assert.equal((await b.json()).chat.chatId,'b');
  const [x,y]=await Promise.all([f.bind('x',B),f.bind('y',B)]);assert.equal(x.status,409);assert.equal(y.status,409);
  assert.equal((await f.call('/chats/a',B)).status,403);
  const rows=JSON.parse(await readFile(f.v2,'utf8'));assert.deepEqual(Object.keys(rows).sort(),['a','b']);
 }finally{await f.close();}
});
for(const kind of ['serve','studio'])test(`${kind} repeat bind preserves mutable state, anchors and unresolved run evidence`,async()=>{
 const f=await fixture(kind);try{
  assert.equal((await f.bind('a')).status,200);const rows=JSON.parse(await readFile(f.v2,'utf8'));
  rows.a={...rows.a,title:'Original changed title',state:'unknown',anchor:{messageId:'12',sha256:'a'.repeat(64)},run:{schemaVersion:1,attemptId:'11111111-1111-4111-8111-111111111111',phase:'unknown',owner:{kind:'v2',chatId:'a',documentRootId:A},identity:{connectionId:'selected',kind,profile:'default',storedSessionId:'remote',installId:kind==='serve'?'install-1':null}}};
  await writeFile(f.v2,JSON.stringify(rows));f.state.title='New remote title';const r=await f.bind('a');assert.equal(r.status,200);assert.equal((await r.json()).chat.state,'unknown');assert.deepEqual(JSON.parse(await readFile(f.v2,'utf8')),rows);
  if(kind==='serve'){f.state.install='changed';assert.equal((await f.bind('a')).status,409);assert.deepEqual(JSON.parse(await readFile(f.v2,'utf8')),rows);}
 }finally{await f.close();}
});
test('same-root concurrent new IDs return one requested ID and an explicit duplicate',async()=>{
 const f=await fixture();try{const responses=await Promise.all([f.bind('a'),f.bind('b')]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);const winner=responses.find(r=>r.status===200)!;assert.ok(['a','b'].includes((await winner.json()).chat.chatId));assert.equal(Object.keys(JSON.parse(await readFile(f.v2,'utf8'))).length,1);}finally{await f.close();}
});
test('filtered current-root recovery verifies only selected connection, preserving old unfiltered behavior',async()=>{
 const f=await fixture('studio');try{
  assert.equal((await f.bind('a')).status,200);assert.equal((await f.bind('b',A,'offline')).status,200);assert.equal((await f.bind('foreign',B)).status,200);f.state.offline=true;
  const r=await f.call('/chats?connection_id=selected');assert.equal(r.status,200);assert.deepEqual((await r.json()).data.map((r:any)=>r.chatId),['a']);
  assert.equal((await f.call('/chats')).status,503);assert.equal((await f.call('/chats?connection_id=missing')).status,404);assert.equal((await f.call('/chats?connection_id=bad%2Fid')).status,400);
 }finally{await f.close();}
});
test('Studio projection repair preserves prior evidence and rejects a changed original identity',async()=>{
 const f=await fixture('studio');try{
  assert.equal((await f.bind('a')).status,200);const old=JSON.parse(await readFile(f.legacy,'utf8'));old[`${A}:remote`].state='unknown';old[`${A}:remote`].custom='preserve';await writeFile(f.legacy,JSON.stringify(old));assert.equal((await f.bind('a')).status,200);assert.deepEqual(JSON.parse(await readFile(f.legacy,'utf8')),old);
  old[`${A}:remote`].profile='other';await writeFile(f.legacy,JSON.stringify(old));assert.equal((await f.bind('a')).status,409);assert.deepEqual(JSON.parse(await readFile(f.legacy,'utf8')),old);
 }finally{await f.close();}
});

for(const mode of ['conflict','missing'] as const)test(`Studio ${mode} second-file result cannot become ready through filtered read-only recovery`,async t=>{
 const f=await studioProjectionFixture(A);try{
  const before=await partialStudioBinding(f,mode,t.mock);const response=await f.call('/chats?connection_id=studio-default');assert.equal(response.status,409);assert.equal((await response.json()).error.code,'chat_conflict');assert.deepEqual(await f.snapshot(),before,'GET must not write either projection');assert.equal((await f.call('/chats')).status,200,'unfiltered old-client contract stays unchanged');assert.deepEqual(await f.snapshot(),before);
  if(mode==='conflict'){assert.equal((await f.bind()).status,409);assert.deepEqual(await f.snapshot(),before);}
  else{
   const rows=JSON.parse(before.v2);rows.requested.state='unknown';rows.requested.title='Retain exact row';rows.requested.run={schemaVersion:1,attemptId:'11111111-1111-4111-8111-111111111111',phase:'unknown',owner:{kind:'v2',chatId:'requested',documentRootId:A},identity:{connectionId:'studio-default',kind:'studio',profile:'default',storedSessionId:'remote',installId:null}};await writeFile(f.v2,JSON.stringify(rows));const protectedRows=await readFile(f.v2,'utf8');
   assert.equal((await f.call('/chats?connection_id=studio-default')).status,409);assert.equal(await readFile(f.v2,'utf8'),protectedRows);const repair=await f.bind('requested');assert.equal(repair.status,200);assert.equal((await repair.json()).chat.state,'unknown');assert.equal(await readFile(f.v2,'utf8'),protectedRows);assert.equal(JSON.parse(await readFile(f.legacy,'utf8'))[`${A}:remote`].profile,'default');
  }
 }finally{await f.close();}
});
