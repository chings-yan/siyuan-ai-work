import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as templates from '../src/work/templates.ts';
import { WorkCreator, type CreateInput } from '../src/work/create.ts';
import { WorkCreateForm } from '../src/work/create-form.ts';
import { WorkStore } from '../src/work/store.ts';
import { WorkService } from '../src/work/service.ts';
import { SiYuanWorkHost } from '../src/work/siyuan-host.ts';

const doc='20261106000000-aaaaaaa',box='20261106000001-bbbbbbb',op='work-create:abcd1234';
const readingMarkdown='## 阅读目标\n\n我想通过阅读弄清什么？\n\n## 关键观点\n\n记录观点及原文出处。\n\n## 我的理解\n\n用自己的话解释，并写下疑问。\n\n## 下一步\n\n记录要验证的问题或行动。';
const reading:templates.WorkTemplateSnapshot={id:'reading',version:1,markdown:readingMarkdown};
const blank:CreateInput={mode:'blank',title:'虚构阅读计划',goal:'',notebookId:box,documentId:null,taskId:null};
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function fixture(){
 const disk=new Map<string,unknown>(),attrs=new Map<string,Record<string,string>>();let creates=0,verified=0,marker=true,mismatch=false,created:any,failVerifiedSave=false;
 const host={listNotebooks:async()=>[{id:box,name:'虚构笔记本'}],getDocumentNotebook:async()=>box,getDocumentTitle:async()=>blank.title,getDocumentPath:async()=>`/${doc}.sy`,searchDocuments:async()=>[],getDocumentIdsByPath:async()=>[],
  getAttrs:async(id:string)=>attrs.get(id)||{},setAttrs:async(id:string,value:Record<string,string>)=>{attrs.set(id,{...attrs.get(id),...value});},getChildren:async()=>[],getBlockMarkdown:async()=>'',appendMarkdown:async()=>{throw Error('template must not append');},prependMarkdown:async()=>{throw Error('empty goal must not prepend');},
  createDocument:async(_box:string,_title:string,_op:string,template?:unknown)=>{creates++;created=structuredClone(template);return doc;},findCreatedDocuments:async()=>marker?[doc]:[],
  verifyCreatedTemplate:async(id:string,notebook:string,operation:string,template:unknown)=>{verified++;assert.equal(id,doc);assert.equal(notebook,box);assert.match(operation,/^work-create:/);assert.deepEqual(template,reading);if(mismatch)throw Error('模板正文未完整读回');},
 };
 const store=new WorkStore({loadData:key=>structuredClone(disk.get(key)),saveData:(key,value)=>{if(failVerifiedSave&&JSON.stringify(value).includes('templateVerified\\":true'))throw Error('虚构存储失败');disk.set(key,structuredClone(value));}});const service=new WorkService(host,store);const tasks={listRecent:async()=>({kind:'found' as const,value:[]}),getTask:async()=>({kind:'missing' as const})};
 const make=()=>new WorkCreator(host,store,service,tasks);
 return {host,store,service,attrs,disk,tasks,make,get creates(){return creates;},get verified(){return verified;},get created(){return created;},set marker(value:boolean){marker=value;},set mismatch(value:boolean){mismatch=value;},set failVerifiedSave(value:boolean){failVerifiedSave=value;}};
}

test('built-in Work templates are explicit immutable versioned choices with no required Goal or task',()=>{
 const list=templates.listWorkTemplates();assert.deepEqual(list.map(t=>t.id),['blank','reading','project','meeting']);
 assert.equal(templates.workTemplateSnapshot('blank'),undefined);assert.deepEqual(templates.workTemplateSnapshot('reading'),reading);
 assert.match(templates.workTemplateSnapshot('project')!.markdown,/## 里程碑/);assert.match(templates.workTemplateSnapshot('meeting')!.markdown,/## 行动项/);
 list[1].title='污染';assert.notEqual(templates.listWorkTemplates()[1].title,'污染');
 assert.throws(()=>templates.workTemplateSnapshot('unknown'),/模板/);
});
test('template selection is frozen before async preflight and sent in the single document creation',async()=>{
 const f=fixture();let release!:()=>void;const hold=new Promise<void>(resolve=>release=resolve);const list=f.host.listNotebooks;let first=true;
 f.host.listNotebooks=async()=>{if(first){first=false;await hold;}return list();};
 const input={...blank,template:{...reading}};const running=f.make().submit(input);input.template.markdown='事后改变';release();const result=await running;
 assert.equal(result.kind,'complete');assert.equal(f.creates,1);assert.equal(f.verified,1);assert.deepEqual(f.created,reading);assert.equal((await f.store.listPending()).length,0);
});
for(const type of ['current','tampered','unsupported'] as const)test('template creation refuses '+type+' before creating or mutating a Work',async()=>{
 const f=fixture();let input:any={...blank,template:{...reading}};
 if(type==='current')input={...input,mode:'current',documentId:doc};
 if(type==='tampered')input.template.markdown+='\n\n意外内容';
 if(type==='unsupported')delete (f.host as any).verifyCreatedTemplate;
 await assert.rejects(f.make().submit(input),/模板|核验/);assert.equal(f.creates,0);assert.equal(f.attrs.size,0);assert.equal((await f.store.listPending()).length,0);
});
test('missing or mismatched template contents keep the existing creation fenced without a second document',async()=>{
 const f=fixture();f.mismatch=true;const first=await f.make().submit({...blank,template:reading});assert.equal(first.kind,'pending');assert.equal(f.creates,1);assert.equal(f.attrs.size,0);
 const pending=(await f.store.listPending())[0];assert.deepEqual(JSON.parse(pending.details).input.template,reading);assert.notEqual(JSON.parse(pending.details).templateVerified,true);
 const still=await f.make().resume(first.operationId);assert.equal(still.kind,'pending');assert.equal(f.creates,1);
 f.mismatch=false;const done=await f.make().resume(first.operationId);assert.equal(done.kind,'complete');assert.equal(f.creates,1);assert.equal((await f.store.listPending()).length,0);
});
test('unknown create with template only reconciles the operation marker and never repeats creation',async()=>{
 const f=fixture();f.marker=false;const first=await f.make().submit({...blank,template:reading});assert.equal(first.kind,'pending');assert.equal(f.verified,0);
 const second=await f.make().resume(first.operationId);assert.equal(second.kind,'pending');assert.equal(f.creates,1);
 f.marker=true;assert.equal((await f.make().resume(first.operationId)).kind,'complete');assert.equal(f.creates,1);assert.equal(f.verified,1);
});
test('legacy no-template pending creation remains compatible without template read capability',async()=>{
 const f=fixture();delete (f.host as any).verifyCreatedTemplate;
 await f.store.setPending({id:op,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:blank,documentId:doc,workReady:false}),updatedAt:'2026-11-06'});
 assert.equal((await f.make().resume(op)).kind,'complete');assert.equal(f.creates,0);
});
test('tampered recovered template snapshot is rejected without restoring or rewriting its body',async()=>{
 const f=fixture();await f.store.setPending({id:op,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,template:{...reading,version:2}},documentId:doc,workReady:false}),updatedAt:'2026-11-06'});
 await assert.rejects(f.make().resume(op),/模板|格式/);assert.equal(f.creates,0);assert.equal(f.verified,0);assert.equal((await f.store.listPending()).length,1);
});
test('failed template verification checkpoint keeps creation fenced before any Work mutation',async()=>{
 const f=fixture();f.failVerifiedSave=true;const first=await f.make().submit({...blank,template:reading});
 assert.equal(first.kind,'pending');assert.equal(f.creates,1);assert.equal(f.verified,1);assert.equal(f.attrs.size,0);assert.equal((await f.store.listPending()).length,1);
 f.failVerifiedSave=false;assert.equal((await f.make().resume(first.operationId)).kind,'complete');assert.equal(f.creates,1);assert.equal(f.verified,2);
});
test('durably verified template recovery preserves later edits while finishing only the optional task step',async()=>{
 const f=fixture();const first=await f.make().submit({...blank,template:reading});assert.equal(first.kind,'complete');
 await f.store.setPending({id:first.operationId,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,template:reading,taskId:'fictional-task'},documentId:doc,workReady:true,templateVerified:true}),updatedAt:'2026-11-06'});
 f.mismatch=true;const second=await f.make().resume(first.operationId,true);assert.equal(second.kind,'complete');assert.equal(f.creates,1);assert.equal(f.verified,1);assert.equal((await f.store.listPending()).length,0);
});

function nativeFixture(){
 const blocks=['Work 创建记录',...readingMarkdown.split('\n\n')],ids=blocks.map((_,i)=>`202611060000${String(i+2).padStart(2,'0')}-ccccccc`);const calls:{path:string;body:Record<string,unknown>}[]=[];const changes={id:false,root:false,body:false,count:false,marker:false,notebook:false,duplicate:false,moved:false,lateTree:false,extraMarker:false,missingId:false};let childReads=0;
 const host=new SiYuanWorkHost(async(path,body)=>{calls.push({path,body});const id=String(body.id),index=ids.indexOf(id);
  if(path==='/api/filetree/createDocWithMd')return doc;
  if(path==='/api/block/getBlockInfo')return {rootID:changes.root?box:doc,box:changes.notebook?doc:box,path:`${changes.moved&&index===2?'/20261106000100-ddddddd':''}/${doc}.sy`};
  if(path==='/api/block/getChildBlocks'){childReads++;return ids.slice(0,changes.count||changes.lateTree&&childReads>1?-1:undefined).map((id,i)=>({id:changes.duplicate&&i===2?ids[1]:id}));}
  if(path==='/api/attr/getBlockAttrs')return index===0?{'custom-ai-work-create-op':changes.marker?'work-create:other':op}:changes.extraMarker&&index===2?{'custom-ai-work-create-op':op}:{};
  if(path==='/api/block/getBlockKramdown')return {id:changes.missingId?undefined:changes.id?doc:id,kramdown:(changes.body&&index===3?'不完整正文':blocks[index])+`\n{: id="${id}"}`};
  throw Error('unexpected native API '+path);
 });return {host,calls,changes};
}
test('native template is included with the operation marker in one create request and verified by complete tree reads',async()=>{
 const f=nativeFixture();assert.equal(await f.host.createDocument(box,'虚构模板',op,reading),doc);
 assert.deepEqual(f.calls[0],{path:'/api/filetree/createDocWithMd',body:{notebook:box,path:'/虚构模板',markdown:`Work 创建记录\n{: custom-ai-work-create-op="${op}"}\n\n${readingMarkdown}`}});
 await f.host.verifyCreatedTemplate(doc,box,op,reading);assert.equal(f.calls.filter(c=>c.path==='/api/filetree/createDocWithMd').length,1);assert.equal(f.calls.filter(c=>c.path==='/api/block/getBlockKramdown').length,9);
 assert.equal(f.calls.some(c=>c.path==='/api/query/sql'||c.path.includes('appendBlock')||c.path.includes('updateBlock')),false);
});
for(const key of ['id','root','body','count','marker','notebook','duplicate','moved','lateTree','extraMarker','missingId'] as const)test('native template readback rejects '+key+' mismatch and never writes to repair it',async()=>{
 const f=nativeFixture();f.changes[key]=true;await assert.rejects(f.host.verifyCreatedTemplate(doc,box,op,reading),/模板|身份|标记/);assert.ok(f.calls.every(c=>!c.path.includes('createDoc')&&!c.path.includes('appendBlock')&&!c.path.includes('updateBlock')));
});
test('native template creation rejects a changed snapshot before submitting any document',async()=>{
 const f=nativeFixture();await assert.rejects(f.host.createDocument(box,'虚构模板',op,{...reading,markdown:readingMarkdown+'\n\n额外正文'}),/模板/);assert.equal(f.calls.length,0);
});
test('native template read timeout is unknown and read-only rather than permission to recreate',async()=>{
 const calls:string[]=[];const host=new SiYuanWorkHost(async(path)=>{calls.push(path);return new Promise(()=>{});},20);
 const started=Date.now();await assert.rejects(host.verifyCreatedTemplate(doc,box,op,reading),/超时.*未知/);assert.ok(Date.now()-started<1000);assert.deepEqual(calls,['/api/block/getBlockInfo']);
});

test('Work form previews exact template only for a new document and current-document submit omits it',async()=>{
 const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});const submitted:any[]=[];
 const creator={prepare:async()=>({context:{documentId:doc,title:'原文档'},notebooks:[{id:box,name:'虚构笔记本'}],notebookId:box,contextNotebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[],submit:async(input:any)=>{submitted.push(input);return {kind:'complete',message:'完成',work:{id:doc}};}} as unknown as WorkCreator;
 const view=new WorkCreateForm(creator,async()=>{});try{await view.open({documentId:doc,title:'原文档'});const select=dom.window.document.querySelector<HTMLSelectElement>('[name="template"]');assert.ok(select);assert.equal(select.value,'blank');
  select.value='reading';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));assert.equal(dom.window.document.querySelector('[data-create-template-preview]')?.textContent,readingMarkdown);
  assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('[name="goal"]')!.value,'');assert.equal(dom.window.document.querySelector<HTMLSelectElement>('[name="task"]')!.value,'');
  const mode=dom.window.document.querySelector<HTMLSelectElement>('[name="mode"]')!;mode.value='current';mode.dispatchEvent(new dom.window.Event('change',{bubbles:true}));assert.equal(dom.window.document.querySelector('[name="template"]'),null);assert.equal(dom.window.document.querySelector('[data-create-template-preview]'),null);
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="submit"]')!.click();await tick();assert.equal(submitted[0].template,undefined);assert.equal(submitted[0].documentId,doc);
 }finally{view.dispose();dom.window.close();}
});
