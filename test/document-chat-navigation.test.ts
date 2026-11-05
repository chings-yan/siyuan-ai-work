import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkController } from '../src/work/controller.ts';
import { WorkStore } from '../src/work/store.ts';
import { WorkService } from '../src/work/service.ts';
import { SiYuanWorkHost } from '../src/work/siyuan-host.ts';
import { decideNavigation } from '../src/work/navigation.ts';
const A='20261012120000-aaaaaaa',B='20261012120001-bbbbbbb',C='20261012120002-ccccccc',X='20261012120003-ddddddd';
async function fixture(){
 const data=new Map<string,any>(),store=new WorkStore({loadData:async k=>data.get(k),saveData:async(k,v)=>{data.set(k,structuredClone(v));}});
 const paths=new Map([[A,`/${A}.sy`],[B,`/${A}/${B}.sy`],[C,`/${A}/${B}/${C}.sy`],[X,`/${X}.sy`]]),marked=new Set([A]),external=new Map<string,string>(),attrs=new Map<string,Record<string,string>>();let failure='',busy=false,pending=false,editor=C;
 const host=new SiYuanWorkHost(async(path,body)=>{
  const id=String(body.id||String(body.stmt).match(/id = '([^']+)'/)?.[1]||'');if(id===failure)throw Error('虚构归属读取失败');
  if(path==='/api/attr/getBlockAttrs')return attrs.get(id)||(external.has(id)?{'custom-ai-work-role':'external-ref','custom-ai-work-document-id':external.get(id)!}:marked.has(id)?{'custom-ai-work-v0':'1'}:{});
  if(path==='/api/block/getChildBlocks')return id===X?[...external.keys()].map(id=>({id})):[];
  if(path==='/api/query/sql'){if(String(body.stmt).startsWith('select path'))return paths.has(id)?[{path:paths.get(id)}]:[];if(String(body.stmt).startsWith('select content'))return [{content:id}];return [];}
  throw Error('unexpected port');
 });
 const service=new WorkService(host,store),changed:(string|null)[]=[],status:string[]=[];
 const controller=new WorkController({host,store,service,taskReader:{} as any,currentDocumentId:()=>editor,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>busy,hasPendingWrite:()=>pending,openDocument:()=>{},onWorkChanged:async id=>{changed.push(id);},onLinkCurrentChat:async()=>{},status:s=>status.push(s)});
 return {controller,store,paths,marked,external,attrs,changed,status,setFailure:(id:string)=>failure=id,setBusy:(v:boolean)=>busy=v,setPending:(v:boolean)=>pending=v,setEditor:(id:string)=>editor=id,close:()=>controller.detach()};
}
test('direct child opening discovers a proven marked ancestor absent from registry',async()=>{const f=await fixture();try{await f.controller.refreshDocument(C);assert.equal(f.controller.currentWorkId,A);assert.deepEqual(await f.store.listWorks(),[A]);assert.deepEqual(f.changed,[A]);}finally{f.close();}});
test('multiple marked ancestors require choice and no mutation until an explicit candidate selection',async()=>{const f=await fixture();try{f.marked.add(B);await f.controller.refreshDocument(C);assert.equal(f.controller.currentWorkId,null);assert.match(f.status.join(' '),/多个|选择/);await assert.rejects((f.controller as any).prepareChatScope(C),/多个|选择/);assert.deepEqual(f.changed,[]);await f.controller.selectWork(B);assert.equal(f.controller.currentWorkId,B);}finally{f.close();}});
for(const bad of ['read','malformed','wrong-parent'] as const)test(`${bad} document ownership never silently falls back to standalone`,async()=>{const f=await fixture();try{if(bad==='read')f.setFailure(A);if(bad==='malformed')f.paths.set(C,'/not-a-document/'+C+'.sy');if(bad==='wrong-parent')f.paths.set(A,`/${X}/${A}.sy`);await f.controller.refreshDocument(C);assert.equal(f.controller.currentWorkId,null);await assert.rejects((f.controller as any).prepareChatScope(C),/读取|路径|核对|归属/);assert.deepEqual(await f.store.listWorks(),[]);}finally{f.close();}});
for(const protection of ['busy','pending'])test(`nullWork ${protection} prevents automatic Work adoption`,async()=>{const f=await fixture();try{if(protection==='busy')f.setBusy(true);else f.setPending(true);await f.controller.refreshDocument(C);assert.equal(f.controller.currentWorkId,null);assert.deepEqual(f.changed,[]);}finally{f.close();}});
test('navigation guard applies even when no Work is selected',()=>{assert.equal(decideNavigation({currentWorkId:null,busy:true,pendingWrite:false},[A]).kind,'keep');assert.equal(decideNavigation({currentWorkId:null,busy:false,pendingWrite:true},[A]).kind,'keep');});

test('a marked ancestor and genuine external association require choice unless current Work is a valid candidate',async()=>{const f=await fixture();try{f.marked.add(X);f.external.set('20261012120004-eeeeeee',C);await f.store.registerWork(X);await f.controller.refreshDocument(C);assert.equal(f.controller.currentWorkId,null);assert.match(f.status.join(' '),/多个|选择/);await f.controller.selectWork(X);await f.controller.refreshDocument(C);assert.equal(f.controller.currentWorkId,X);assert.equal(await f.controller.prepareChatScope(C),X);}finally{f.close();}});
test('a malformed ancestor Work marker blocks standalone mutation instead of being treated as absent',async()=>{const f=await fixture();try{f.marked.clear();f.attrs.set(A,{'custom-ai-work-v0':'unexpected'});await f.controller.refreshDocument(C);await assert.rejects(f.controller.prepareChatScope(C),/标记|核对/);assert.deepEqual(await f.store.listWorks(),[]);assert.deepEqual(f.changed,[]);}finally{f.close();}});

test('duplicate external role references still resolve to one Work candidate',async()=>{const f=await fixture();try{f.marked.clear();f.marked.add(X);f.external.set('20261012120004-eeeeeee',C);f.external.set('20261012120005-fffffff',C);await f.store.registerWork(X);await f.controller.refreshDocument(C);assert.equal(f.controller.currentWorkId,X);assert.deepEqual(f.changed,[X]);assert.equal(await f.controller.prepareChatScope(C),X);}finally{f.close();}});
