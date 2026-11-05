import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const W='20261008120000-aaaaaaa',D='20261008120001-bbbbbbb';
const task={id:'fictional-selected-task',title:'待关联任务',completed:false,documentId:D,projectId:'fictional-project',createdAt:''};
const temp=mkdtempSync(join(tmpdir(),'task3b-plugin-'));
const bundle=join(temp,'index.cjs');buildSync({entryPoints:['src/index.ts'],bundle:true,platform:'browser',format:'cjs',external:['siyuan'],outfile:bundle});
process.on('exit',()=>rmSync(temp,{recursive:true,force:true}));
export const tick=()=>new Promise(r=>setTimeout(r,10));
export async function fixture(options:{confirmed?:boolean}={}){
 const dom=new JSDOM('<body><div id="dock"></div><main></main><div id="editor"></div></body>');const doc=dom.window.document;
 Object.assign(globalThis,{document:doc,window:dom.window,MutationObserver:dom.window.MutationObserver});
 let opens=0,calendar=0;const app:any={plugins:[]};
 const editors:any[]=[{protyle:{app,element:doc.querySelector('#editor')!,block:{rootID:W}}}];
 app.plugins=[{app,name:'siyuan-plugin-task-note-management',commands:[{langKey:'shortcutSetDocumentAsTask',editorCallback:(p:any)=>{assert.equal(p,editors[0].protyle);opens++;}},{langKey:'shortcutOpenCalendarView',callback:()=>{calendar++;}}]}];
 const original=(Module as any)._load;
 (Module as any)._load=function(request:string,parent:any,isMain:boolean){if(request==='siyuan')return {Plugin:class{app=app;},getAllEditor:()=>editors,openTab:()=>{assert.fail('association or native entry must not navigate');}};return original.call(this,request,parent,isMain);};
 let C:any;try{const require=createRequire(import.meta.url);delete require.cache[require.resolve(bundle)];C=require(bundle).default;}finally{(Module as any)._load=original;}
 const p:any=new C(),data=new Map();p.loadData=async(k:string)=>data.get(k);p.saveData=async(k:string,v:any)=>data.set(k,structuredClone(v));
 let activeDoc=W;p.currentDocumentId=()=>activeDoc;p.workHost.getAttrs=async()=>({'custom-ai-work-v0':'1'});p.currentFocusBlockId=()=>null;p.workHost.getDocumentTitle=async(id:string)=>id===W?'冻结 Work 文档':'任务实际文档';p.workHost.getDocumentPath=async(id:string)=>`/${id}.sy`;p.workHost.listDescendantDocuments=async()=>[];p.workService.listExternalDocuments=async()=>[];p.workService.readWork=async(id:string)=>({id,title:id===W?'冻结 Work':'其他 Work',goal:'',status:'active'});
 p.taskReader.listRecent=async()=>({kind:'found',value:[task]});p.taskReader.search=async()=>({kind:'found',value:[task]});p.taskReader.getTask=async(id:string)=>{assert.equal(id,task.id);return {kind:'found',value:task};};
 await p.workStore.registerWork(W);p.workController.workId=W;p.workController.documentId=W;
 const root=doc.querySelector<HTMLElement>('#dock')!;p.render(root);await p.onWorkChanged(W);await tick();
 const page=p.mountWorkPage(doc.querySelector('main'),{documentId:W,title:'冻结 Work 文档',focusBlockId:null});await page.refresh();
 p.bridgeToken='fictional-token';p.connectionViews=[{id:'serve-local',kind:'serve',profile:'default',installId:'fictional-install',displayName:'Fictional Serve',state:'ready'}];
 if(options.confirmed!==false){p.confirmedConnectionId='serve-local';data.set('settings',{bridgeUrl:p.bridgeUrl,bridgeToken:p.bridgeToken,hermesConnectionId:'serve-local'});}
 const input=root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value='原 Chat 草稿';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));const chat=p.activeThreadId;
 return {p,page,root,input,chat,doc,dom,opens:()=>opens,calendar:()=>calendar,setDocument:(id:string)=>activeDoc=id,close(){page.dispose();p.taskDialog?.dispose();for(const r of [...p.roomViews.keys()])p.disposeRoomView(r);p.workController.detach();dom.window.close();}};
}

export function link(id:string,storedSessionId='same-remote',connectionId='serve-local'){return {chatId:id,workId:W,documentRootId:W,connectionId,adapter:'serve',profile:'default',installId:'fictional-install',storedSessionId,title:id,state:'ready'};}
