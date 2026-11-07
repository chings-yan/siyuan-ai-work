import assert from 'node:assert/strict';
import fsPromises,{mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error runtime ESM
import {createBridgeServer} from '../scripts/bridge.mjs';
export const PROJECTION_CAP='d'.repeat(64);
/** Synthetic ports only; the HTTP handler and both binding stores remain production code. */
export async function studioProjectionFixture(root:string){
 const dir=await mkdtemp(join(tmpdir(),'studio-projection-')),legacy=join(dir,'legacy.json'),v2=join(dir,'v2.json');
 await writeFile(legacy,'{}');
 const state:{afterCandidate:(()=>Promise<void>)|null}={afterCandidate:null};
 const {server}=createBridgeServer({capability:PROJECTION_CAP,bindingsFile:legacy,bindingsV2File:v2,studioToken:'synthetic',connections:{defaultConnectionId:'studio-default',connections:[{id:'studio-default',kind:'studio',profile:'default'}]},
  fetchImpl:async(url:any)=>{if(String(url).endsWith('/api/studio/sessions')&&state.afterCandidate){const action=state.afterCandidate;state.afterCandidate=null;await action();}return Response.json({sessions:[{id:'remote',title:'Synthetic',profile:'default'}],messages:[],hasMore:false});}});
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const calls:{method:string;path:string}[]=[];server.on('request',(req:any)=>calls.push({method:req.method,path:req.url}));
 const call=(path:string,body?:unknown)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Siyuan-Collab-Token':PROJECTION_CAP,'X-Siyuan-Document-Root':root},...(body?{body:JSON.stringify(body)}:{})});
 const bind=(chatId='requested')=>call('/chats/bind',{chat_id:chatId,connection_id:'studio-default',stored_session_id:'remote',confirm:true});
 const snapshot=async()=>({v2:await readFile(v2,'utf8'),legacy:await readFile(legacy,'utf8')});
 return {base,legacy,v2,root,calls,state,call,bind,snapshot,async close(){await new Promise<void>(done=>server.close(()=>done()));await rm(dir,{recursive:true,force:true});}};
}
export async function partialStudioBinding(f:Awaited<ReturnType<typeof studioProjectionFixture>>,mode:'conflict'|'missing',mock:{method:Function;restoreAll:()=>void}){
 if(mode==='conflict')f.state.afterCandidate=async()=>writeFile(f.legacy,JSON.stringify({[`${f.root}:remote`]:{id:'remote',documentRootId:f.root,profile:'other',source:'studio',title:'Preserved original'}}));
 else{
  const rename=fsPromises.rename;
  mock.method(fsPromises,'rename',async(from:any,to:any)=>{if(to===f.legacy)throw Object.assign(Error('synthetic second-file rename denied'),{code:'EACCES'});return rename(from,to);});syncBuiltinESMExports();
 }
 try{const response=await f.bind();assert.equal(response.status,mode==='conflict'?409:500);if(mode==='conflict')assert.equal((await response.json()).error.code,'chat_conflict');}
 finally{mock.restoreAll();syncBuiltinESMExports();}
 const rows=JSON.parse(await readFile(f.v2,'utf8'));assert.equal(rows.requested.chatId,'requested');assert.equal(rows.requested.state,'ready');
 return f.snapshot();
}
