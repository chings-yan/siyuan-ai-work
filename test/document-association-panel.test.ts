import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createChatShell} from '../src/ui.ts';
const D='20990101000000-aaaaaaa',OTHER='20990101000001-bbbbbbb';
const task={id:'fictional-task',title:'<img src=x onerror=alert(1)> 原任务',completed:false,documentId:OTHER,projectId:'project',createdAt:''};
const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(check:()=>boolean){for(let i=0;i<100;i++){if(check())return;await tick();}assert.fail('panel operation did not settle');}
async function fixture(){
 const m=await import('../src/work/document-panel.ts').catch((e:any)=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {} as any;});assert.equal(typeof m.DocumentAssociationPanel,'function','production document panel must exist');
 const dom=new JSDOM(`<body>${createChatShell()}</body>`);const root=dom.window.document.querySelector<HTMLElement>('.sac')!;
 let doc={id:D,title:'普通文档'},linked=false,workLinked=false,edits=0,sends=0,confirm=true,searches=0;let lookup:any={kind:'found',value:task};
 const options:any={currentDocument:()=>doc,documentTitle:async(id:string)=>id===OTHER?'原主文档':'另一主文档',loadWorks:async()=>[{id:OTHER,title:'原 Work',goal:'工作目标',status:'active',relation:workLinked?'reference':'none'}],
  linkWork:async(id:string,w:any,current:()=>boolean)=>{assert.equal(id,D);assert.equal(w.id,OTHER);assert.ok(current());workLinked=true;},
  listTaskLinks:async()=>linked?[{taskId:task.id,task:lookup}]:[],searchTasks:async()=>{searches++;return {kind:'found',value:[task]};},
  linkTask:async(id:string,t:any,current:()=>boolean)=>{assert.equal(id,D);assert.equal(t.id,task.id);assert.ok(current());linked=true;},
  unlinkTask:async(id:string,t:string,current:()=>boolean)=>{assert.equal(id,D);assert.equal(t,task.id);assert.ok(current());linked=false;},
  editTask:async(id:string,t:string,current:()=>boolean)=>{assert.equal(id,D);assert.equal(t,task.id);assert.ok(current());edits++;return '已打开原任务编辑';},openWork:()=>{},createWork:async()=>{},confirm:()=>confirm};
 root.querySelector('form')!.addEventListener('submit',e=>{e.preventDefault();sends++;});
 const panel=new m.DocumentAssociationPanel(root,options),q=(s:string)=>root.querySelector<HTMLElement>(s),click=(s:string)=>{const b=q(s);assert.ok(b,s);b.click();};
 return {panel,root,dom,options,q,click,linked:()=>linked,workLinked:()=>workLinked,edits:()=>edits,sends:()=>sends,searches:()=>searches,setLookup:(v:any)=>lookup=v,setDoc:()=>{doc={id:OTHER,title:'另一文档'};panel.documentChanged();},cancel:()=>confirm=false,close(){panel.dispose();dom.window.close();}};
}
test('switching production dock views preserves composer, history, quoted material and selected conversation with zero sends',async()=>{
 const f=await fixture();try{const area=f.q('textarea') as HTMLTextAreaElement;area.value='未发送草稿';f.q('[data-messages]')!.textContent='历史正文';f.q('[data-references]')!.textContent='引用资料';const select=f.q('[data-thread-selector]') as HTMLSelectElement;select.innerHTML='<option value="original">原会话</option>';
 f.click('[data-dock-tab="associations"]');await until(()=>!!f.q('[data-doc-action="link-work"]'));assert.equal(f.root.dataset.dockView,'associations');f.click('[data-dock-tab="chat"]');assert.equal(f.root.dataset.dockView,'chat');assert.equal(f.q('textarea'),area);assert.equal(area.value,'未发送草稿');assert.equal(f.q('[data-messages]')!.textContent,'历史正文');assert.equal(f.q('[data-references]')!.textContent,'引用资料');assert.equal(select.value,'original');assert.equal(f.sends(),0);
 }finally{f.close();}
});
test('ordinary document task link, native edit, refreshed completion and exact unlink work without Work navigation',async()=>{
 const f=await fixture();try{f.click('[data-dock-tab="associations"]');f.click('[data-doc-section="tasks"]');await until(()=>!!f.q('[data-doc-action="link-task"]'));assert.equal(f.root.querySelector('img'),null);
 f.click('[data-doc-action="link-task"]');f.click('[data-doc-action="link-task"]');await until(()=>!!f.q('[data-doc-action="edit-task"]'));assert.ok(f.linked());assert.match(f.q('[data-document-associations]')!.textContent||'',/主文档.*保留/);
 f.setLookup({kind:'found',value:{...task,completed:true}});f.click('[data-doc-action="edit-task"]');await until(()=>f.edits()===1&&/已完成/.test(f.q('[data-doc-linked]')!.textContent||''));
 f.setLookup({kind:'unavailable',reason:'离线'});f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));await until(()=>/暂不可读/.test(f.q('[data-doc-linked]')!.textContent||''));assert.ok(f.linked());
 f.click('[data-doc-action="unlink-task"]');await until(()=>!f.linked());assert.equal(f.sends(),0);
 }finally{f.close();}
});
test('Work association confirms one target and refreshes its existing relation in place',async()=>{
 const f=await fixture();try{f.click('[data-dock-tab="associations"]');await until(()=>!!f.q('[data-doc-action="link-work"]'));f.click('[data-doc-action="link-work"]');await until(()=>/已关联资料/.test(f.q('[data-doc-results]')!.textContent||''));assert.ok(f.workLinked());assert.equal(f.root.dataset.dockView,'associations');}finally{f.close();}
});
test('cancelled confirmation and failed mutations do not show success or discard the draft',async()=>{
 const f=await fixture();try{f.click('[data-dock-tab="associations"]');f.click('[data-doc-section="tasks"]');await until(()=>!!f.q('[data-doc-action="link-task"]'));f.cancel();f.click('[data-doc-action="link-task"]');await tick();assert.equal(f.linked(),false);
 f.options.confirm=()=>true;f.options.linkTask=async()=>{throw Error('关联未保存');};f.click('[data-doc-action="link-task"]');await until(()=>/未保存/.test(f.q('[data-doc-notice]')!.textContent||''));assert.equal(f.linked(),false);
 }finally{f.close();}
});
test('search preserves input and composition; superseded read and late action cannot affect a new document',async()=>{
 const f=await fixture();try{f.click('[data-dock-tab="associations"]');f.click('[data-doc-section="tasks"]');await until(()=>!!f.q('[data-doc-action="link-task"]'));
 const input=f.q('[data-doc-search]') as HTMLInputElement;input.focus();const n=f.searches();input.dispatchEvent(new f.dom.window.CompositionEvent('compositionstart',{bubbles:true}));input.value='工作';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,180));assert.equal(f.searches(),n);input.dispatchEvent(new f.dom.window.CompositionEvent('compositionend',{bubbles:true}));await until(()=>f.searches()>n);assert.equal(f.q('[data-doc-search]'),input);assert.equal(input.value,'工作');assert.equal(f.dom.window.document.activeElement,input);
 let release!:()=>void;f.options.linkTask=async(_d:string,_t:any,current:()=>boolean)=>{await new Promise<void>(r=>release=r);assert.equal(current(),false);throw Error('旧页面已失效');};await until(()=>!!f.q('[data-doc-action="link-task"]'));f.click('[data-doc-action="link-task"]');await until(()=>!!release);f.setDoc();release();await tick();assert.doesNotMatch(f.q('[data-doc-notice]')!.textContent||'',/旧页面|已关联/);assert.match(f.q('[data-doc-current]')!.textContent||'',/另一文档/);
 }finally{f.close();}
});
test('late search, missing document, unavailable source and disposal leave no stale selectable entries',async()=>{
 const f=await fixture();try{let finish!:(v:any)=>void;f.options.searchTasks=()=>new Promise(r=>finish=r);f.click('[data-dock-tab="associations"]');f.click('[data-doc-section="tasks"]');await until(()=>!!finish);f.options.searchTasks=async()=>({kind:'unavailable',reason:'原任务插件不可用'});f.setDoc();await until(()=>/不可用/.test(f.q('[data-doc-results]')!.textContent||''));finish({kind:'found',value:[task]});await tick();assert.equal(f.q('[data-doc-action="link-task"]'),null);
 f.options.currentDocument=()=>null;f.panel.documentChanged();assert.match(f.q('[data-doc-current]')!.textContent||'',/打开.*文档/);assert.equal(f.q('[data-doc-action="link-task"]'),null);f.panel.dispose();f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));assert.equal(f.sends(),0);
 }finally{f.close();}
});
test('typing a Work filter while the catalog is loading retains the latest query and eventually shows matching rows',async()=>{
 const f=await fixture();try{let done!:(v:any)=>void;f.options.loadWorks=()=>new Promise(r=>done=r);f.click('[data-dock-tab="associations"]');const input=f.q('[data-doc-search]') as HTMLInputElement;input.value='长标题';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));done([{id:OTHER,title:'虚构长标题 Work',goal:'',status:'active',relation:'none'}]);await until(()=>!!f.q('[data-doc-action="link-work"]'));assert.equal(input.value,'长标题');}finally{f.close();}
});
test('review I1: a task update during confirmation invalidates the pending choice and is not discarded while busy',async()=>{
 const f=await fixture();try{f.click('[data-dock-tab="associations"]');f.click('[data-doc-section="tasks"]');await until(()=>!!f.q('[data-doc-action="link-task"]'));let release!:()=>void;let valid:boolean|undefined;
 f.options.linkTask=async(_d:string,_t:any,current:()=>boolean)=>{await new Promise<void>(r=>release=r);valid=current();if(!valid)throw Error('选择已变化');};f.click('[data-doc-action="link-task"]');await until(()=>!!release);const searches=f.searches();f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));release();await until(()=>valid!==undefined);assert.equal(valid,false);await until(()=>f.searches()>searches);assert.match(f.q('[data-doc-notice]')!.textContent||'',/任务.*更新|变化/);
 }finally{f.close();}
});
test('review I2: same-title tasks expose their original document and project in rows and confirmation; selected identity is exact',async()=>{
 const f=await fixture();try{const first={...task,title:'提交周报'},second={...first,id:'second-task',documentId:D,projectId:'second-project'};f.options.searchTasks=async()=>({kind:'found',value:[first,second]});let message='',selected='';f.options.confirm=(m:string)=>{message=m;return true;};f.options.linkTask=async(_d:string,t:any)=>{selected=t.id;};
 f.click('[data-dock-tab="associations"]');f.click('[data-doc-section="tasks"]');await until(()=>f.root.querySelectorAll('[data-doc-action="link-task"]').length===2);const rows=[...f.root.querySelectorAll('[data-doc-results] article')];assert.notEqual(rows[0].textContent,rows[1].textContent);assert.match(rows[0].textContent||'',/原主文档.*project/s);assert.match(rows[1].textContent||'',/另一主文档.*second-project/s);
 (rows[1].querySelector('[data-doc-action="link-task"]') as HTMLElement).click();await until(()=>!!selected);assert.equal(selected,'second-task');assert.match(message,/另一主文档/);assert.match(message,/second-project/);assert.match(message,/second-task/);
 }finally{f.close();}
});
test('review I2: identical titles and origins, unavailable titles and unlinked source records retain inspectable identity',async()=>{
 const f=await fixture();try{f.options.documentTitle=async()=>{throw Error('unreadable');};f.options.searchTasks=async()=>({kind:'found',value:[{...task,title:'周报'},{...task,id:'other-task',title:'周报'}]});f.options.listTaskLinks=async()=>[{taskId:'gone-task',task:{kind:'missing'}}];
 f.click('[data-dock-tab="associations"]');f.click('[data-doc-section="tasks"]');await until(()=>f.root.querySelectorAll('[data-doc-action="link-task"]').length===2);assert.match(f.q('[data-doc-results]')!.textContent||'',/名称暂不可读/);const rows=[...f.root.querySelectorAll('[data-doc-results] article')];assert.notEqual(rows[0].querySelector('details')?.textContent,rows[1].querySelector('details')?.textContent);assert.match(f.q('[data-doc-linked]')!.textContent||'',/gone-task/);
 }finally{f.close();}
});
for(const move of ['same','outside','gone'] as const)test(`review M1: background refresh preserves action identity without stealing focus: ${move}`,async()=>{
 const f=await fixture();try{f.click('[data-dock-tab="associations"]');f.click('[data-doc-section="tasks"]');await until(()=>!!f.q('[data-doc-action="link-task"]'));const b=f.q('[data-doc-action="link-task"]')!;b.focus();let finish!:(v:any)=>void;f.options.searchTasks=()=>new Promise(r=>finish=r);f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));await until(()=>!!finish);
 const outside=f.dom.window.document.createElement('input');f.dom.window.document.body.append(outside);if(move==='outside')outside.focus();finish({kind:'found',value:move==='gone'?[]:[task]});await until(()=>!f.q('[data-doc-results]')!.textContent?.includes('正在读取'));
 assert.equal(f.dom.window.document.activeElement,move==='outside'?outside:move==='gone'?f.q('[data-doc-results]'):f.q('[data-doc-action="link-task"]'));
 }finally{f.close();}
});
