import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import * as form from '../src/work/create-form.ts';
import { WorkCreator } from '../src/work/create.ts';
const doc='20260929120000-abcdef0',box='20260929120001-abcdef0';
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));

test('blocked recovery opens its own document and explicitly keeps the record while offering a new form',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});dom.window.confirm=()=>true;
  let aside='',opened='',submits=0;
  const recovery={id:'work-create:old',workId:doc,details:JSON.stringify({version:1,input:{mode:'current',documentId:doc,title:'旧文档'},documentId:doc,workReady:false})};
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[recovery],setAsideExistingCreation:async(id:string,approved:boolean)=>{assert.equal(approved,true);aside=id;},submit:async()=>{submits++;}} as unknown as WorkCreator;
  const view=new (form.WorkCreateForm as any)(creator,async()=>{},()=>'',async(id:string)=>{opened=id;});await view.open(null);await tick();
  const open=dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="open-pending"]');assert.ok(open);open.click();await tick();assert.equal(opened,doc);
  const keep=dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="set-aside"]');assert.ok(keep);keep.click();await tick();
  assert.equal(aside,'work-create:old');assert.equal(submits,0);assert.ok(dom.window.document.querySelector('[data-create-action="submit"]'));assert.match(dom.window.document.body.textContent||'',/保留.*待核对|待核对.*保留/);view.dispose();dom.window.close();
});

test('old Work repair previews the saved Goal and requires an explicit confirmation',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  let approve=false,confirmation='',calls=0;dom.window.confirm=(value:string)=>{confirmation=value;return approve;};
  const recovery={id:'work-create:repair',workId:doc,details:JSON.stringify({version:1,input:{mode:'current',documentId:doc,title:'旧文档',goal:'恢复目标'},documentId:doc,workReady:false})};
  let pending=[recovery];const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>pending,repairExistingCreation:async(id:string,confirmed:boolean)=>{assert.equal(id,recovery.id);assert.equal(confirmed,true);calls++;pending=[];return {kind:'complete',operationId:id,message:'Work 已修复',work:{id:doc}};}} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  assert.match(dom.window.document.body.textContent||'',/恢复目标/);
  const button=dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="repair"]');assert.ok(button);
  assert.equal(dom.window.document.querySelector('[data-create-action="skip"]'),null);
  button.click();assert.equal(calls,0);assert.match(confirmation,/恢复目标/);
  approve=true;button.click();await tick();assert.equal(calls,1);assert.match(dom.window.document.body.textContent||'',/Work 已修复/);
  view.dispose();dom.window.close();
});

test('old pending Work offers an explicit no-Goal continuation and keeps repair separate',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  let accepted=false,question='',continued=0;dom.window.confirm=(value:string)=>{question=value;return accepted;};
  const recovery={id:'work-create:optional-goal',workId:doc,details:JSON.stringify({version:1,input:{mode:'current',documentId:doc,title:'旧文档',goal:'原先填写的目标',taskId:null},documentId:doc,workReady:false})};
  let pending=[recovery];const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>pending,continueWithoutGoal:async(id:string,approved:boolean)=>{assert.equal(id,recovery.id);assert.equal(approved,true);continued++;pending=[];return {kind:'complete',operationId:id,message:'无目标 Work 已建立',work:{id:doc}};}} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  assert.ok(dom.window.document.querySelector('[data-create-action="repair"]'));
  assert.equal(dom.window.document.querySelector('[data-create-action="resume"]'),null);
  const button=dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="without-goal"]');assert.ok(button);
  button.click();assert.equal(continued,0);assert.match(question,/不写入|不补|不采用/);
  accepted=true;button.click();await tick();assert.equal(continued,1);assert.match(dom.window.document.body.textContent||'',/无目标 Work 已建立/);
  view.dispose();dom.window.close();
});

test('creation form labels the Goal optional and submits a blank Goal',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const submitted:any[]=[];const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[],submit:async(input:any)=>{submitted.push(input);return {kind:'complete',operationId:'new',message:'Work 已建立',work:{id:doc}};}} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  assert.match(dom.window.document.body.textContent||'',/工作目标（可选）/);
  const name=dom.window.document.querySelector<HTMLInputElement>('[name="title"]')!;name.value='无目标工作';name.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  const notebook=dom.window.document.querySelector<HTMLSelectElement>('[name="notebook"]')!;notebook.value=box;notebook.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="submit"]')!.click();await tick();
  assert.equal(submitted[0].goal,'');view.dispose();dom.window.close();
});

test('after an unknown repair result, the form offers reconciliation without promising another write',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const recovery={id:'work-create:repair-unknown',workId:doc,details:JSON.stringify({version:1,input:{mode:'current',documentId:doc,title:'旧文档',goal:'恢复目标',taskId:null},documentId:doc,workReady:false,repairAttempted:true})};
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[recovery]} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  assert.match(dom.window.document.querySelector('[data-create-action="repair"]')?.textContent||'',/核对.*修复/);
  assert.doesNotMatch(dom.window.document.body.textContent||'',/再次写入目标/);
  view.dispose();dom.window.close();
});

test('a repaired Work awaiting its optional task does not look like an unresolved Goal write',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const recovery={id:'work-create:repair-task-pending',workId:doc,details:JSON.stringify({version:1,input:{mode:'current',documentId:doc,title:'旧文档',goal:'恢复目标',taskId:'task-1'},documentId:doc,workReady:true,repairAttempted:true})};
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[recovery]} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  assert.match(dom.window.document.body.textContent||'',/记录显示 Work 已建立.*剩余关联/);
  assert.equal(dom.window.document.querySelector('[data-create-action="repair"]'),null);
  assert.match(dom.window.document.querySelector('[data-create-action="resume"]')?.textContent||'',/继续.*关联/);
  assert.ok(dom.window.document.querySelector('[data-create-action="skip"]'));
  view.dispose();dom.window.close();
});

test('creation task search selects an older native task and rejects late search results',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});let release!:(v:any)=>void;const submitted:any[]=[];
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[],searchTasks:async(q:string)=>q==='旧'?new Promise(r=>release=r):{kind:'found',value:[{id:'older',title:'招聘方案',completed:false}]},submit:async(i:any)=>{submitted.push(i);return {kind:'complete',message:'完成',work:{id:doc}};}} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  const input=dom.window.document.querySelector<HTMLInputElement>('[name="taskSearch"]');assert.ok(input);
  input.value='旧';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));
  input.value='招聘';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));release({kind:'found',value:[{id:'late',title:'迟到任务',completed:false}]});await tick();
  assert.equal(dom.window.document.querySelector('[name="taskSearch"]'),input);assert.doesNotMatch(dom.window.document.querySelector('[data-create-task-results]')?.textContent||'',/迟到/);
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="choose-task"][data-task-id="older"]')!.click();
  for(const [name,value] of [['title','新工作'],['goal','明确目标']]){const e=dom.window.document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;e.value=value;e.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="submit"]')!.click();await tick();assert.equal(submitted[0].taskId,'older');view.dispose();dom.window.close();
});

test('clearing creation task search removes unselected matches and retains an explicitly selected task',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[{id:'recent',title:'最近任务'}]}),pending:async()=>[],searchTasks:async()=>({kind:'found',value:[{id:'older',title:'搜索任务'}]})} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  const input=dom.window.document.querySelector<HTMLInputElement>('[name="taskSearch"]')!;
  const type=(query:string)=>{input.value=query;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  type('搜索');await new Promise(r=>setTimeout(r,220));assert.ok(dom.window.document.querySelector('[name="task"] option[value="older"]'));
  type('');assert.equal(dom.window.document.querySelector('[name="task"] option[value="older"]'),null);assert.ok(dom.window.document.querySelector('[name="task"] option[value="recent"]'));
  type('搜索');await new Promise(r=>setTimeout(r,220));dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="choose-task"]')!.click();type('');
  assert.equal(dom.window.document.querySelector<HTMLSelectElement>('[name="task"]')!.value,'older');view.dispose();dom.window.close();
});
test('new Work defaults to a new document and explicitly selects the captured document',async()=>{
  assert.equal(typeof form.WorkCreateForm,'function');
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const submitted:any[]=[];let entered='';
  const creator={prepare:async(c:any)=>({context:{...c},notebooks:[{id:box,name:'工作笔记本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'unavailable',reason:'offline'}),pending:async()=>[],submit:async(i:any)=>{submitted.push(i);return {kind:'complete',message:'Work 已建立',work:{id:doc}};}} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async(id:string)=>{entered=id;});
  const context={documentId:doc,title:'冻结文档'};await view.open(context);context.documentId='20260929120002-abcdef0';await tick();
  assert.equal(dom.window.document.querySelector<HTMLSelectElement>('[name="mode"]')?.value,'blank');
  const mode=dom.window.document.querySelector<HTMLSelectElement>('[name="mode"]')!;mode.value='current';mode.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  assert.match(dom.window.document.body.textContent||'',/冻结文档/);
  assert.match(dom.window.document.body.textContent||'',/offline/);
  const goal=dom.window.document.querySelector<HTMLTextAreaElement>('[name="goal"]')!;goal.value='明确目标';goal.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="submit"]')!.click();await tick();
  assert.equal(submitted[0].documentId,doc);assert.equal(submitted[0].taskId,null);assert.equal(submitted[0].goal,'明确目标');assert.equal(entered,'');
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="enter"]')!.click();await tick();assert.equal(entered,doc);view.dispose();dom.window.close();
});

test('existing document search chooses a different frozen root before creation',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const other='20260929120002-abcdef0',submitted:any[]=[];
  const creator={prepare:async(c:any)=>({context:c,notebooks:[{id:box,name:'工作笔记本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[],searchDocuments:async()=>[{id:other,title:'另一篇文档',notebookId:box}],submit:async(i:any)=>{submitted.push(i);return {kind:'complete',message:'完成',work:{id:other}};}} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open({documentId:doc,title:'当前文档'});
  const mode=dom.window.document.querySelector<HTMLSelectElement>('[name="mode"]')!;mode.value='current';mode.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  const search=dom.window.document.querySelector<HTMLInputElement>('[name="documentSearch"]')!;search.value='另一';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await tick();
  dom.window.document.querySelector<HTMLButtonElement>(`[data-create-action="choose-document"][data-document-id="${other}"]`)!.click();await tick();
  const goal=dom.window.document.querySelector<HTMLTextAreaElement>('[name="goal"]')!;goal.value='整理资料';goal.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="submit"]')!.click();await tick();
  assert.equal(submitted[0].mode,'current');assert.equal(submitted[0].documentId,other);
  view.dispose();dom.window.close();
});

test('late document search cannot replace newer choices or lose the typing field',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const other='20260929120002-abcdef0';let release!:(rows:any[])=>void;
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[],searchDocuments:async(q:string)=>q==='旧'?new Promise(resolve=>{release=resolve;}):[{id:other,title:'新文档',notebookId:box}]} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);
  const mode=dom.window.document.querySelector<HTMLSelectElement>('[name="mode"]')!;mode.value='current';mode.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  const search=dom.window.document.querySelector<HTMLInputElement>('[name="documentSearch"]')!;
  search.value='旧';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  search.value='新';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await tick();
  release([{id:doc,title:'旧文档',notebookId:box}]);await tick();
  assert.equal(dom.window.document.querySelector('[name="documentSearch"]'),search);
  assert.match(dom.window.document.querySelector('[data-create-results]')?.textContent||'',/新文档/);
  assert.doesNotMatch(dom.window.document.querySelector('[data-create-results]')?.textContent||'',/旧文档/);
  view.dispose();dom.window.close();
});
test('form without editor requires notebook choice, unknown results show verify rather than another submit',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'可选本'}],notebookId:'',locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[{id:'op',details:'{}'}],resume:async()=>({kind:'pending',operationId:'op',work:null,message:'尚不能确认'})} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  assert.equal(dom.window.document.querySelector('[data-create-action="submit"]'),null);
  assert.ok(dom.window.document.querySelector('[data-create-action="resume"]'));
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="resume"]')!.click();await tick();assert.match(dom.window.document.body.textContent||'',/尚不能确认/);
  view.dispose();dom.window.close();
});

test('document search finishes while new-document mode is shown and is usable on return',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  let release!:(rows:any[])=>void;
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[],searchDocuments:async()=>new Promise(resolve=>{release=resolve;})} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  const mode=(value:string)=>{const el=dom.window.document.querySelector<HTMLSelectElement>('[name="mode"]')!;el.value=value;el.dispatchEvent(new dom.window.Event('change',{bubbles:true}));};
  mode('current');const search=dom.window.document.querySelector<HTMLInputElement>('[name="documentSearch"]')!;
  search.value='目标';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));mode('blank');
  release([{id:doc,title:'目标文档',notebookId:box}]);await tick();mode('current');
  assert.doesNotMatch(dom.window.document.querySelector('[data-create-results]')?.textContent||'',/正在搜索/);
  assert.match(dom.window.document.querySelector('[data-create-results]')?.textContent||'',/目标文档/);
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="choose-document"]')!.click();
  assert.match(dom.window.document.querySelector('.sac-create-selected')?.textContent||'',new RegExp(doc));
  view.dispose();dom.window.close();
});
test('blank form requires explicit notebook and retains corrected input after validation error',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const submissions:any[]=[];
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'可选本'}],notebookId:'',locationError:''}),recentTasks:async()=>({kind:'found',value:[]}),pending:async()=>[],submit:async(input:any)=>{submissions.push(input);if(!input.notebookId)throw new Error('请选择笔记本');return {kind:'complete',message:'完成',work:{id:doc}};}} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  const set=(name:string,value:string)=>{const el=dom.window.document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;el.value=value;el.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  assert.equal(dom.window.document.querySelector<HTMLSelectElement>('[name="notebook"]')!.value,'');
  assert.match(dom.window.document.body.textContent||'',/可选本.*根目录/s);set('title','新工作');set('goal','明确目标');
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="submit"]')!.click();await tick();
  assert.match(dom.window.document.body.textContent||'',/请选择笔记本/);set('notebook',box);
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="submit"]')!.click();await tick();
  assert.equal(submissions.length,2);assert.equal(submissions[1].goal,'明确目标');assert.equal(submissions[1].notebookId,box);
  view.dispose();dom.window.close();
});

test('creation form submits the task identity frozen when the user selected it',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const selected={id:'task-selected',title:'初始任务',completed:false,documentId:doc,projectId:'project-a',createdAt:'2026-10-01'};
  const submitted:any[]=[];
  const creator={prepare:async()=>({context:null,notebooks:[{id:box,name:'工作本'}],notebookId:box,locationError:''}),recentTasks:async()=>({kind:'found',value:[selected]}),pending:async()=>[],submit:async(input:any)=>{submitted.push(input);return {kind:'complete',message:'完成',work:{id:doc}};}} as unknown as WorkCreator;
  const view=new form.WorkCreateForm(creator,async()=>{});await view.open(null);await tick();
  const task=dom.window.document.querySelector<HTMLSelectElement>('[name="task"]')!;
  task.value=selected.id;task.dispatchEvent(new dom.window.Event('change',{bubbles:true}));
  selected.title='后来改名';selected.documentId='20260929120002-abcdef0';selected.projectId='project-b';
  const title=dom.window.document.querySelector<HTMLInputElement>('[name="title"]')!;title.value='新工作';title.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="submit"]')!.click();await tick();
  assert.equal(submitted.length,1);
  assert.deepEqual(submitted[0].taskSelection,{id:'task-selected',title:'初始任务',documentId:doc,projectId:'project-a'});
  view.dispose();dom.window.close();
});
