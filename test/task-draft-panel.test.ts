import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import type { TaskDraftSource } from '../src/task/draft.ts';
const source:TaskDraftSource={kind:'answer',key:'fictional-message-v1',documentId:'20261106000000-aaaaaaa',documentTitle:'虚构文档'};
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
async function fixture(options:{body?:string;openNative?:(source:TaskDraftSource,current:()=>boolean)=>Promise<any>;associate?:(source:TaskDraftSource,current:()=>boolean)=>Promise<void>;copyText?:(text:string)=>Promise<void>;prepareNext?:(source:TaskDraftSource,current:()=>boolean)=>boolean|Promise<boolean>}={}){
 assert.ok(existsSync(new URL('../src/task/draft-panel.ts',import.meta.url)),'reviewed drafts require a local, guarded panel');
 const {TaskDraftPanel}=await import('../src/task/draft-panel.ts');
 const dom=new JSDOM('<body><button id="origin">草稿入口</button><button id="outside">外部入口</button></body>');
 const document=dom.window.document;let current=true,nativeCalls=0,associationCalls=0,prepareCalls=0;const copied:string[]=[];
 const origin=document.querySelector<HTMLButtonElement>('#origin')!;origin.focus();
 const panel=new TaskDraftPanel(document,{prepareNext:async(value,guard)=>{prepareCalls++;assert.equal(guard(),true);return options.prepareNext?options.prepareNext(value,guard):true;},isCurrent:(value:TaskDraftSource)=>current&&value.key===source.key,copyText:async text=>{copied.push(text);await options.copyText?.(text);},openNative:async(value,guard)=>{nativeCalls++;assert.equal(guard(),true);return options.openNative?options.openNative(value,guard):{kind:'opened'};},associate:async(value,guard)=>{associationCalls++;assert.equal(guard(),true);await options.associate?.(value,guard);}});
 panel.open({source,body:options.body??'拟定标题\n完整说明'});
 const element=()=>document.querySelector<HTMLElement>('[data-task-draft]')!;
 const button=(name:string)=>{const found=document.querySelector<HTMLButtonElement>(`[data-task-draft-action="${name}"]`);assert.ok(found,name);return found;};
 const field=(name:string)=>{const found=document.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[data-task-draft-field="${name}"]`);assert.ok(found,name);return found;};
 const edit=(name:string,value:string)=>{field(name).value=value;field(name).dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 return {dom,document,panel,origin,element,button,field,edit,copied,nativeCalls:()=>nativeCalls,associationCalls:()=>associationCalls,prepareCalls:()=>prepareCalls,setCurrent:(value:boolean)=>current=value,close:()=>{panel.dispose();dom.window.close();}};
}

test('task draft panel never creates or copies automatically and copies only edited review',async()=>{
 const f=await fixture();try{assert.equal(f.nativeCalls(),0);assert.equal(f.associationCalls(),0);assert.equal(f.copied.length,0);f.edit('title','核对标题');f.edit('description','核对后的说明');f.button('copy').click();await tick();assert.equal(f.copied.length,1);assert.match(f.copied[0],/^标题：核对标题\n\n说明：\n核对后的说明/);assert.match(f.copied[0],/siyuan:\/\/blocks\/20261106000000-aaaaaaa/);assert.doesNotMatch(f.copied[0],/fictional-message/);assert.match(f.element().textContent||'',/不.*自动.*填|手动/);}finally{f.close();}
});
test('task draft panel keeps independently edited candidates and complete original text',async()=>{
 const body='- [ ] 第一项\n- [ ] 第二项\n保留原始说明';const f=await fixture({body});try{f.edit('title','改过第一项');f.edit('description','第一项说明');const select=f.document.querySelector<HTMLSelectElement>('[data-task-draft-items]')!;select.value='1';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));assert.equal(f.field('title').value,'第二项');f.edit('description','第二项说明');select.value='0';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));assert.equal(f.field('title').value,'改过第一项');assert.equal(f.field('description').value,'第一项说明');assert.equal(f.document.querySelector('[data-task-draft-original]')!.textContent,body);}finally{f.close();}
});
test('task draft panel treats source, title and description as text, including original injection',async()=>{
 const body='<img src=x onerror=alert(1)>\n<script>globalThis.injected=true</script>';const f=await fixture({body});try{assert.equal(f.element().querySelector('img,script'),null);assert.equal(f.document.querySelector('[data-task-draft-original]')!.textContent,body);assert.equal(f.field('description').value,body);f.button('copy').click();await tick();assert.match(f.copied[0],/<script>/);}finally{f.close();}
});
test('task draft panel shows excessive length without truncation and refuses action until reviewed',async()=>{
 const body='题'.repeat(201)+'\n说明';const f=await fixture({body});try{assert.equal(f.field('title').value,'题'.repeat(201));assert.match(f.element().textContent||'',/201\s*\/\s*200/);assert.equal(f.button('copy').disabled,true);assert.equal(f.button('open-native').disabled,true);f.edit('title','已核对');assert.equal(f.button('copy').disabled,false);}finally{f.close();}
});
test('task draft panel stale source keeps edits and copy but blocks native creation and association',async()=>{
 const f=await fixture();try{f.edit('description','保留的编辑');f.setCurrent(false);f.button('open-native').click();f.button('associate').click();await tick();assert.equal(f.nativeCalls(),0);assert.equal(f.associationCalls(),0);assert.equal(f.field('description').value,'保留的编辑');assert.match(f.element().textContent||'',/来源.*变|文档.*变/);f.button('copy').click();await tick();assert.match(f.copied[0],/保留的编辑/);}finally{f.close();}
});
test('task draft panel opens native once, never passes text as prefill and never claims saved',async()=>{
 let resolve!:(value:any)=>void;let seen:TaskDraftSource|undefined;const f=await fixture({openNative:async value=>{seen=value;return new Promise(r=>resolve=r);}});try{f.button('open-native').click();f.button('open-native').click();assert.equal(f.nativeCalls(),1);assert.deepEqual(seen,source);assert.deepEqual(Object.keys(seen!).sort(),['documentId','documentTitle','key','kind']);resolve({kind:'opened'});await tick();assert.equal(f.button('open-native').disabled,true);assert.match(f.element().textContent||'',/不表示.*已.*保存|尚未确认.*保存/);assert.equal(f.associationCalls(),0);f.button('close').click();f.panel.open({source,body:'再次打开'});f.button('open-native').click();assert.equal(f.nativeCalls(),1);}finally{f.close();}
});
for(const outcome of ['throw','unknown','undefined'])test(`task draft panel keeps ${outcome} native result unknown with no retry`,async()=>{
 const f=await fixture({openNative:async()=>{if(outcome==='throw')throw Error('private backend details');if(outcome==='unknown')return {kind:'unknown',reason:'原任务入口结果未能确认，请先核对。'};return undefined;}});try{f.button('open-native').click();await tick();assert.equal(f.button('open-native').disabled,true);assert.match(f.element().textContent||'',/未知|核对/);assert.doesNotMatch(f.element().textContent||'',/private backend details/);f.button('close').click();f.panel.open({source,body:'再次打开'});f.button('open-native').click();assert.equal(f.nativeCalls(),1);}finally{f.close();}
});
test('task draft panel permits explicit retry only for a proved blocked native entry',async()=>{
 const f=await fixture({openNative:async()=>({kind:'blocked'})});try{f.button('open-native').click();await tick();assert.equal(f.button('open-native').disabled,false);assert.equal(f.nativeCalls(),1);f.button('open-native').click();await tick();assert.equal(f.nativeCalls(),2);}finally{f.close();}
});
test('task draft panel opens exact association flow once without inventing save or link success',async()=>{
 let finish!:()=>void;const f=await fixture({associate:()=>new Promise<void>(r=>finish=r)});try{f.button('associate').click();f.button('associate').click();assert.equal(f.associationCalls(),1);assert.equal(f.nativeCalls(),0);finish();await tick();assert.equal(f.document.querySelector('[data-task-draft]'),null);assert.equal(f.copied.length,0);f.panel.open({source,body:'拟定标题\n完整说明'});assert.match(f.element().textContent||'',/准确选择|精确选择/);assert.doesNotMatch(f.element().querySelector('[role="status"]')!.textContent||'',/已关联成功|任务已创建/);}finally{f.close();}
});
test('task draft panel leaves external focus alone on native completion and close',async()=>{
 let finish!:(value:any)=>void;const f=await fixture({openNative:()=>new Promise(r=>finish=r)});try{f.button('open-native').click();const outside=f.document.querySelector<HTMLButtonElement>('#outside')!;outside.focus();finish({kind:'opened'});await tick();assert.equal(f.document.activeElement,outside);f.panel.close();assert.equal(f.document.activeElement,outside);}finally{f.close();}
});
test('task draft panel ignores late callbacks after disposal and exposes guards for source change',async()=>{
 let finish!:(value:any)=>void;let guard!:()=>boolean;const f=await fixture({openNative:async(_source,current)=>{guard=current;return new Promise(r=>finish=r);}});try{f.button('open-native').click();assert.equal(guard(),true);f.setCurrent(false);assert.equal(guard(),false);f.panel.dispose();assert.equal(guard(),false);finish({kind:'opened'});await tick();assert.equal(f.document.querySelector('[data-task-draft]'),null);assert.equal(f.copied.length,0);}finally{f.close();}
});
test('task draft panel traps keyboard navigation and restores origin only on its own close',async()=>{
 const f=await fixture();try{const overlay=f.element();const first=f.button('close'),last=f.button('associate');last.focus();last.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));assert.equal(f.document.activeElement,first);overlay.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(f.document.querySelector('[data-task-draft]'),null);assert.equal(f.document.activeElement,f.origin);}finally{f.close();}
});
test('task draft panel exports scoped layout for narrow and short windows',async()=>{
 assert.ok(existsSync(new URL('../src/task/draft-panel.ts',import.meta.url)));const {TASK_DRAFT_CSS}=await import('../src/task/draft-panel.ts');assert.match(TASK_DRAFT_CSS,/\[data-task-draft\]/);assert.match(TASK_DRAFT_CSS,/max-height/);assert.match(TASK_DRAFT_CSS,/overflow[^;]*auto/);assert.match(TASK_DRAFT_CSS,/min-width:\s*0/);
});

test('task draft panel copy error preserves edits and never exposes exception details',async()=>{
 const f=await fixture({copyText:async()=>{throw Error('private clipboard payload');}});try{f.edit('description','尚未复制的内容');f.button('copy').click();await tick();assert.equal(f.field('description').value,'尚未复制的内容');assert.match(f.element().textContent||'',/复制未成功/);assert.doesNotMatch(f.element().textContent||'',/private clipboard/);assert.equal(f.button('copy').disabled,false);assert.equal(f.nativeCalls(),0);}finally{f.close();}
});
test('task draft panel association error preserves review without assuming linked or retrying',async()=>{
 const f=await fixture({associate:async()=>{throw Error('private task list');}});try{f.button('associate').click();await tick();assert.equal(f.associationCalls(),1);assert.ok(f.element());assert.match(f.element().textContent||'',/未能确认|核对/);assert.doesNotMatch(f.element().textContent||'',/private task list/);assert.equal(f.field('description').value,'拟定标题\n完整说明');assert.equal(f.nativeCalls(),0);}finally{f.close();}
});
test('task draft panel checks source at callback boundary and keeps guard after association handoff',async()=>{
 let currentGuard!:()=>boolean;const f=await fixture({associate:async(_source,guard)=>{currentGuard=guard;}});try{f.button('associate').click();await tick();assert.equal(f.document.querySelector('[data-task-draft]'),null);assert.equal(currentGuard(),true);f.setCurrent(false);assert.equal(currentGuard(),false);f.panel.dispose();assert.equal(currentGuard(),false);}finally{f.close();}
});
test('task draft panel preserves same-source edits on close/reopen and marks changed source text stale',async()=>{
 const f=await fixture();try{f.edit('title','保留标题');f.button('close').click();f.panel.open({source,body:'拟定标题\n完整说明'});assert.equal(f.field('title').value,'保留标题');f.panel.open({source,body:'来源内容后来改变'});assert.equal(f.field('title').value,'保留标题');assert.equal(f.button('open-native').disabled,true);assert.equal(f.button('associate').disabled,true);assert.equal(f.button('copy').disabled,false);assert.match(f.element().textContent||'',/来源.*变化/);}finally{f.close();}
});
test('task draft panel cannot silently replace an open review or accept detached button events',async()=>{
 const f=await fixture();try{const oldNative=f.button('open-native');f.edit('title','保留编辑');assert.equal(f.panel.open({source:{...source,key:'later-message'},body:'后来回答'}),false);assert.equal(f.field('title').value,'保留编辑');f.button('close').click();oldNative.click();assert.equal(f.nativeCalls(),0);f.panel.open({source,body:'拟定标题\n完整说明'});oldNative.click();assert.equal(f.nativeCalls(),0);assert.equal(f.field('title').value,'保留编辑');}finally{f.close();}
});
test('task draft panel rejects empty input before mounting any partial review',async()=>{
 const f=await fixture();try{f.button('close').click();assert.throws(()=>f.panel.open({source:{...source,key:'empty-source'},body:' \n'}),/内容/);assert.equal(f.document.querySelector('[data-task-draft]'),null);}finally{f.close();}
});
test('task draft panel busy actions keep budget, ignore Escape and cannot open a new source',async()=>{
 let finish!:(value:any)=>void;const f=await fixture({openNative:async()=>new Promise(r=>finish=r)});try{f.button('open-native').click();const overlay=f.element();overlay.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(f.element(),overlay);assert.equal(f.panel.open({source:{...source,key:'new-source'},body:'新草稿'}),false);finish({kind:'opened'});await tick();assert.equal(f.nativeCalls(),1);f.button('close').click();assert.equal(f.document.querySelector('[data-task-draft]'),null);}finally{f.close();}
});

test('task draft panel explains retained native result after edits and copying',async()=>{
 const f=await fixture({openNative:async()=>({kind:'unknown'})});try{f.button('open-native').click();await tick();f.edit('title','修订标题');assert.match(f.element().textContent||'',/结果未知/);f.button('copy').click();await tick();assert.equal(f.button('open-native').disabled,true);assert.match(f.element().textContent||'',/结果未知/);}finally{f.close();}
});

for(const outcome of ['opened','unknown'])test(`task draft panel requires explicit reviewed prepare-next for ${outcome} entry`,async()=>{
 const f=await fixture({openNative:async()=>({kind:outcome})});try{assert.equal(f.button('prepare-next').hidden,true);f.button('open-native').click();await tick();assert.equal(f.prepareCalls(),0);assert.equal(f.button('prepare-next').hidden,false);assert.match(f.element().textContent||'',/不证明.*已创建|不证明.*保存/);assert.match(f.element().textContent||'',/不撤销/);f.button('close').click();f.panel.open({source,body:'拟定标题\n完整说明'});assert.equal(f.prepareCalls(),0);assert.equal(f.button('open-native').disabled,true);f.button('prepare-next').click();f.button('prepare-next').click();await tick();assert.equal(f.prepareCalls(),1);assert.equal(f.nativeCalls(),1);assert.equal(f.button('open-native').disabled,false);if(outcome==='unknown')assert.match(f.element().textContent||'',/此前.*未知/);f.button('open-native').click();await tick();assert.equal(f.nativeCalls(),2);}finally{f.close();}
});
for(const outcome of ['false','throw'])test(`task draft panel keeps original native result when prepare-next returns ${outcome}`,async()=>{
 const f=await fixture({openNative:async()=>({kind:'unknown'}),prepareNext:async()=>{if(outcome==='throw')throw Error('private reset data');return false;}});try{f.button('open-native').click();await tick();f.button('prepare-next').click();await tick();assert.equal(f.prepareCalls(),1);assert.equal(f.button('open-native').disabled,true);assert.match(f.element().textContent||'',/未知/);assert.doesNotMatch(f.element().textContent||'',/private reset data/);assert.equal(f.nativeCalls(),1);}finally{f.close();}
});
test('task draft panel cannot prepare another entry from changed source and ignores late preparation',async()=>{
 let finish!:(value:boolean)=>void;const f=await fixture({openNative:async()=>({kind:'opened'}),prepareNext:()=>new Promise<boolean>(r=>finish=r)});try{f.button('open-native').click();await tick();f.setCurrent(false);f.button('prepare-next').click();await tick();assert.equal(f.prepareCalls(),0);f.setCurrent(true);f.panel.refresh();f.button('prepare-next').click();assert.equal(f.prepareCalls(),1);f.setCurrent(false);finish(true);await tick();assert.equal(f.button('open-native').disabled,true);f.setCurrent(true);f.panel.refresh();assert.equal(f.button('open-native').disabled,true);assert.equal(f.nativeCalls(),1);}finally{f.close();}
});

test('task draft panel preserves public prior-entry reason without claiming this source was opened',async()=>{
 const reason='原插件中还有此前发起的任务入口；本次未重新打开。请先核对，再明确准备下一次创建。';
 const f=await fixture({openNative:async()=>({kind:'unknown',reason})});try{f.button('open-native').click();await tick();const status=()=>f.element().querySelector('[role="status"]')!.textContent||'';assert.match(status(),/本次未重新打开/);assert.ok(status().includes(reason));assert.doesNotMatch(status(),/已打开任务插件入口/);assert.equal(f.button('open-native').disabled,true);f.edit('description','核对后保留');assert.ok(status().includes(reason));f.button('copy').click();await tick();assert.ok(status().includes(reason));f.button('close').click();f.panel.open({source,body:'拟定标题\n完整说明'});assert.ok(status().includes(reason));assert.equal(f.nativeCalls(),1);assert.equal(f.prepareCalls(),0);}finally{f.close();}
});
test('task draft panel renders bounded public unknown reason as inert text',async()=>{
 const reason='本次未重新打开 <img src=x onerror=alert(1)> <script>window.injected=true</script>';const f=await fixture({openNative:async()=>({kind:'unknown',reason})});try{f.button('open-native').click();await tick();assert.ok(f.element().querySelector('[role="status"]')!.textContent!.includes(reason));assert.equal(f.element().querySelector('img,script'),null);assert.equal(f.button('open-native').disabled,true);}finally{f.close();}
});
for(const reason of ['长'.repeat(501),{message:'private nested error'}])test(`task draft panel falls back for ${typeof reason} out-of-contract unknown reason`,async()=>{
 const f=await fixture({openNative:async()=>({kind:'unknown',reason})});try{f.button('open-native').click();await tick();const text=f.element().querySelector('[role="status"]')!.textContent||'';assert.match(text,/结果未知/);assert.doesNotMatch(text,/长长|private nested/);assert.equal(f.button('open-native').disabled,true);}finally{f.close();}
});
test('task draft panel does not publish blocked adapter exception reasons',async()=>{
 const f=await fixture({openNative:async()=>({kind:'blocked',reason:'private editor exception'})});try{f.button('open-native').click();await tick();assert.doesNotMatch(f.element().textContent||'',/private editor exception/);assert.match(f.element().querySelector('[role="status"]')!.textContent||'',/未打开任务插件入口/);}finally{f.close();}
});
