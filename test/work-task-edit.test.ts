import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {WorkPage} from '../src/work/page.ts';
import {WorkNativeTab} from '../src/work/native-tab.ts';
const W='20261105120000-aaaaaaa';
const task=(id:string,completed=false)=>({id,title:`虚构${id}`,completed,documentId:null,projectId:null,createdAt:'',customProgress:37});
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
function fixture(){
 const dom=new JSDOM('<body><main></main><input id="native"></body>',{pretendToBeVisual:true}),root=dom.window.document.querySelector<HTMLElement>('main')!;
 const row:any={id:W,record:{value:{id:W,title:'虚构Work',goal:'',status:'active'}},documents:{value:[]},tasks:{value:[{workId:W,taskId:'one',connectionId:'siyuan-native-local',lookup:{kind:'found',value:task('one')}}]},chats:{value:[]},rooms:{value:[]},resume:{value:null}};
 const snapshot:any={works:[row],continueWorks:[],recentTasks:{kind:'found',value:[task('one')]}};
 const reads:string[]=[],edits:string[]=[],changes:string[]=[];let allow=true;
 const reader:any={getTask:async(id:string)=>{reads.push(id);return {kind:'found',value:task(id,true)};},listRecent:async()=>({kind:'found',value:[]}),search:async()=>({kind:'found',value:[task('search')]})};
 const actions:any={enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{},editTask:async(id:string,taskId:string,current:()=>boolean)=>{assert.equal(id,W);assert.equal(current(),true);edits.push(taskId);return '已发起打开原生任务编辑器；不表示保存';},setStatus:async(_id:string,next:string,expected:string,current:()=>boolean)=>{assert.equal(current(),true);assert.equal(expected,row.record.value.status);if(!allow)return false;changes.push(next);row.record.value.status=next;return true;}};
 const page=new WorkPage(root,{catalog:{load:async()=>snapshot},context:null,taskReader:reader,actions});
 return {dom,root,row,snapshot,reader,reads,actions,edits,changes,page,setAllow:(value:boolean)=>allow=value,close(){page.dispose();dom.window.close();}};
}
test('详情常显完成与恢复，取消不写入，次要状态仍可明确进入',async()=>{
 const f=fixture();try{await f.page.refresh();f.page.show({kind:'detail',workId:W});
  const finish=f.root.querySelector<HTMLButtonElement>('[data-page-action="set-status"][data-next-status="completed"]');assert.ok(finish);assert.equal(finish.closest('details'),null);
  f.setAllow(false);finish.click();await tick();assert.deepEqual(f.changes,[]);
  f.setAllow(true);finish.click();await tick();assert.deepEqual(f.changes,['completed']);
  const restore=f.root.querySelector<HTMLButtonElement>('[data-page-action="set-status"][data-next-status="active"]');assert.ok(restore);assert.equal(restore.closest('details'),null);restore.click();await tick();assert.deepEqual(f.changes,['completed','active']);
  const select=f.root.querySelector<HTMLSelectElement>('[data-work-next-status]');assert.ok(select);assert.ok(select.querySelector('[value="paused"]'));assert.ok(select.querySelector('[value="closed"]'));
 }finally{f.close();}
});
test('页面显示真实已完成/N、未知和缺失，原生独立进度不替代完成标记',async()=>{
 const f=fixture();try{f.row.tasks.value.push({workId:W,taskId:'two',connectionId:'siyuan-native-local',lookup:{kind:'found',value:task('two',true)}},{workId:W,taskId:'unknown',lookup:{kind:'unavailable',reason:'offline'}},{workId:W,taskId:'gone',lookup:{kind:'missing'}});
  await f.page.refresh();assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/已完成 1\/4/);
  f.page.show({kind:'detail',workId:W,section:'tasks'});assert.match(f.root.textContent||'',/已完成 1\/4.*未知 1.*缺失 1/s);assert.match(f.root.textContent||'',/任务插件进度：37%/);
  assert.match(f.root.querySelector('[data-linked-tasks]')!.textContent||'',/未完成/);
  f.row.tasks.value=[];await f.page.refresh();assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/未关联任务/);
 }finally{f.close();}
});
test('逐任务编辑显示正在打开并防双击，不重绘或抢走原生弹窗焦点',async()=>{
 const f=fixture();try{let finish!:(s:string)=>void;f.actions.editTask=async(_id:string,id:string,current:()=>boolean)=>{assert.equal(current(),true);f.edits.push(id);return new Promise(resolve=>finish=resolve);};
  await f.page.refresh();f.page.show({kind:'detail',workId:W,section:'tasks'});const button=f.root.querySelector<HTMLButtonElement>('[data-page-action="edit-task"]');assert.ok(button);button.focus();button.click();
  assert.match(f.root.textContent||'',/正在打开任务/);assert.equal(button.disabled,true);button.click();assert.deepEqual(f.edits,['one']);
  const native=f.dom.window.document.querySelector<HTMLInputElement>('#native')!;native.focus();finish('已发起；不表示保存');await tick();assert.equal(f.dom.window.document.activeElement,native);assert.equal(button.isConnected,true);assert.match(f.root.textContent||'',/已发起/);
 }finally{f.close();}
});
test('迟到编辑结果不能覆盖新页面',async()=>{
 const f=fixture();try{let finish!:(s:string)=>void;let current!:()=>boolean;f.actions.editTask=(_id:string,_task:string,guard:()=>boolean)=>{current=guard;return new Promise(resolve=>finish=resolve);};
  await f.page.refresh();f.page.show({kind:'detail',workId:W,section:'tasks'});f.root.querySelector<HTMLButtonElement>('[data-page-action="edit-task"]')!.click();f.page.show({kind:'list'});assert.equal(current(),false);finish('不应出现的迟到说明');await tick();assert.doesNotMatch(f.root.textContent||'',/迟到说明/);
 }finally{f.close();}
});
test('只读刷新保持详情分类、工作状态选择与输入节点，失败保留任务关联',async()=>{
 const f=fixture();try{await f.page.refresh();f.page.show({kind:'detail',workId:W,section:'tasks'});
  const select=f.root.querySelector<HTMLSelectElement>('[data-work-next-status]')!;select.value='closed';select.focus();await f.page.refreshTasks();
  assert.equal(f.root.querySelector('[data-work-next-status]'),select);assert.equal(select.value,'closed');assert.equal(f.dom.window.document.activeElement,select);assert.equal(f.root.querySelector('[data-section="tasks"]')!.getAttribute('aria-current'),'page');assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/已完成 1\/1/);
  f.reader.getTask=async()=>{throw Error('虚构读取失败');};await f.page.refreshTasks();assert.equal(f.root.querySelectorAll('[data-page-action="edit-task"]').length,0);assert.match(f.root.textContent||'',/虚构读取失败/);assert.match(f.root.textContent||'',/one/);assert.equal(f.row.tasks.value.length,1);
 }finally{f.close();}
});
test('刷新保持主页搜索、光标、滚动及实际搜索结果，返回任务事件不清空查询',async()=>{
 const f=fixture();try{await f.page.refresh();const input=f.root.querySelector<HTMLInputElement>('[data-page-task-search]')!;input.value='虚构';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,180));input.focus();input.setSelectionRange(1,1);const panel=f.root.querySelector<HTMLElement>('.sac-work-page')!;panel.scrollTop=81;
  await f.page.refreshTasks();assert.equal(f.root.querySelector('[data-page-task-search]'),input);assert.equal(f.dom.window.document.activeElement,input);assert.equal(input.value,'虚构');assert.equal(input.selectionStart,1);assert.equal(panel.scrollTop,81);assert.match(f.root.querySelector('[data-page-task-results]')!.textContent||'',/虚构search/);
 }finally{f.close();}
});
test('刷新合并重复事件，迟到读取不能覆盖导航后页面，卸载不再读取',async()=>{
 const f=fixture();try{await f.page.refresh();let finish!:(v:unknown)=>void;f.reader.getTask=()=>new Promise(resolve=>finish=resolve);
  const first=f.page.refreshTasks(),second=f.page.refreshTasks();assert.equal(first,second);f.page.show({kind:'list'});finish({kind:'found',value:task('one',true)});await first;assert.equal(f.root.querySelectorAll('[data-section]').length,0);assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/已完成 0\/1/);
  f.page.dispose();let reads=0;f.reader.getTask=async()=>{reads++;return {kind:'found',value:task('one')};};await f.page.refreshTasks();assert.equal(reads,0);
 }finally{f.close();}
});
test('原生页签是窗口事件唯一所有者，只对可见页面合并刷新并在销毁解绑',async()=>{
 const f=fixture();const oldWindow=globalThis.window,oldDocument=globalThis.document;Object.assign(globalThis,{window:f.dom.window,document:f.dom.window.document});let registration:any;let refreshes=0;const realRefresh=f.page.refreshTasks?.bind(f.page);(f.page as any).refreshTasks=async()=>{refreshes++;await realRefresh?.();};
 const plugin:any={name:'fixture',app:{},addTab:(value:any)=>registration=value};const tab=new WorkNativeTab(plugin,async()=>({} as any),()=>f.page);
 try{registration.init.call({element:f.root});await tick();
  f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));await tick();assert.equal(refreshes,1);assert.deepEqual(f.reads,['one']);
  f.root.hidden=true;f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));await tick();assert.equal(refreshes,1);f.root.hidden=false;
  f.dom.window.document.dispatchEvent(new f.dom.window.Event('visibilitychange'));await tick();assert.equal(refreshes,2);
  const removed:string[]=[];const originalRemove=f.dom.window.removeEventListener.bind(f.dom.window);f.dom.window.removeEventListener=(type:string,listener:any,options?:any)=>{removed.push(type);originalRemove(type,listener,options);};
  registration.destroy.call({element:f.root});assert.ok(removed.includes('reminderUpdated'));assert.ok(removed.includes('focus'));f.dom.window.dispatchEvent(new f.dom.window.Event('focus'));await tick();assert.equal(refreshes,2);tab.dispose();f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));await tick();assert.equal(refreshes,2);
 }finally{tab.dispose();f.close();Object.assign(globalThis,{window:oldWindow,document:oldDocument});}
});

test('读取进行中再次失效会合并为一次后续读取，不丢失保存后的任务变化',async()=>{
 const f=fixture();try{await f.page.refresh();f.page.show({kind:'detail',workId:W,section:'tasks'});let finish!:(value:unknown)=>void,calls=0;
  f.reader.getTask=async()=>{calls++;if(calls===1)return new Promise(resolve=>finish=resolve);return {kind:'found',value:task('one',true)};};
  const first=f.page.refreshTasks();await tick();const second=f.page.refreshTasks();assert.equal(second,first);finish({kind:'found',value:task('one',false)});await first;
  assert.equal(calls,2);assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/已完成 1\/1/);
 }finally{f.close();}
});

test('保存后刷新即使焦点返回编辑按钮，也立刻更新任务完成显示并保持焦点位置',async()=>{
 const f=fixture();try{await f.page.refresh();f.page.show({kind:'detail',workId:W,section:'tasks'});f.root.querySelector<HTMLButtonElement>('[data-page-action="edit-task"]')!.focus();
  await f.page.refreshTasks();assert.match(f.root.querySelector('[data-linked-tasks]')!.textContent||'',/已完成/);assert.doesNotMatch(f.root.querySelector('[data-linked-tasks]')!.textContent||'',/未完成/);assert.equal((f.dom.window.document.activeElement as HTMLElement).dataset.pageAction,'edit-task');assert.equal((f.dom.window.document.activeElement as HTMLElement).dataset.taskId,'one');
 }finally{f.close();}
});

for(const initial of [true,false])test(`完整读取${initial?'首次':'已有数据'}期间的保存通知在载入后补读，不丢失新状态`,async()=>{
 const f=fixture();try{if(!initial)await f.page.refresh();let release!:(value:unknown)=>void;let loads=0;
  (f.page as any).options.catalog.load=()=>{loads++;return new Promise(resolve=>release=resolve);};
  const full=f.page.refresh();await f.page.refreshTasks();release(f.snapshot);await full;assert.equal(loads,1);assert.deepEqual(f.reads,['one']);assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/已完成 1\/1/);
 }finally{f.close();}
});
test('在途刷新收到第二次通知后页面隐藏，不再发起尾随读取',async()=>{
 const f=fixture();try{await f.page.refresh();let release!:(value:unknown)=>void,calls=0;f.reader.getTask=()=>{calls++;if(calls>1)return Promise.resolve({kind:'found',value:task('one')});return new Promise(resolve=>release=resolve);};const first=f.page.refreshTasks();await tick();f.page.refreshTasks();f.root.hidden=true;release({kind:'found',value:task('one')});await first;assert.equal(calls,1);
 }finally{f.close();}
});

test('刷新在精确任务读取后页面已卸载，不继续读取推荐或搜索',async()=>{
 const f=fixture();try{await f.page.refresh();let release!:(value:unknown)=>void,recentReads=0;f.reader.getTask=()=>new Promise(resolve=>release=resolve);f.reader.listRecent=async()=>{recentReads++;return {kind:'found',value:[]};};
  const refresh=f.page.refreshTasks();f.page.dispose();release({kind:'found',value:task('one')});await refresh;assert.equal(recentReads,0);
 }finally{f.close();}
});

test('旧页任务读取在途时新页收到保存通知，串行转交新页并显示最新状态',async()=>{
 const f=fixture();let release!:(value:unknown)=>void;try{await f.page.refresh();let calls=0,inflight=0,peak=0;
  f.reader.getTask=async()=>{calls++;inflight++;peak=Math.max(peak,inflight);try{if(calls===1)return await new Promise(resolve=>release=resolve);return {kind:'found',value:task('one',true)};}finally{inflight--;}};
  const first=f.page.refreshTasks();f.page.show({kind:'detail',workId:W,section:'tasks'});const select=f.root.querySelector<HTMLSelectElement>('[data-work-next-status]')!;select.value='closed';select.focus();
  const second=f.page.refreshTasks();assert.equal(first,second);release({kind:'found',value:task('one',false)});await Promise.all([first,second]);
  assert.equal(calls,2);assert.equal(peak,1);assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/已完成 1\/1/);assert.match(f.root.querySelector('[data-linked-tasks]')!.textContent||'',/已完成/);
  assert.equal(f.root.querySelector('[data-work-next-status]'),select);assert.equal(select.value,'closed');assert.equal(f.dom.window.document.activeElement,select);assert.equal(f.row.tasks.value.length,1);
 }finally{release?.({kind:'found',value:task('one')});f.close();}
});

test('保存后通知搜索结束loading，较早同查询搜索迟到不覆盖新任务结果',async()=>{
 const f=fixture();let release!:(value:unknown)=>void;try{await f.page.refresh();let calls=0,started!:()=>void;const firstStarted=new Promise<void>(resolve=>started=resolve);
  f.reader.search=async(query:string)=>{assert.equal(query,'虚构');calls++;if(calls===1){started();return new Promise(resolve=>release=resolve);}return {kind:'found',value:[{...task('one'),title:'保存后新标题'}]};};
  const input=f.root.querySelector<HTMLInputElement>('[data-page-task-search]')!;input.value='虚构';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await firstStarted;input.focus();input.setSelectionRange(1,1);const panel=f.root.querySelector<HTMLElement>('.sac-work-page')!;panel.scrollTop=73;
  await f.page.refreshTasks();const afterNew=f.root.querySelector('[data-page-task-results]')!.textContent||'';
  release({kind:'found',value:[{...task('one'),title:'保存前旧标题'}]});await tick();const final=f.root.querySelector('[data-page-task-results]')!.textContent||'';
  assert.deepEqual({newVisible:afterNew.includes('保存后新标题'),loadingAfterNew:afterNew.includes('正在搜索'),finalNew:final.includes('保存后新标题'),finalOld:final.includes('保存前旧标题')},{newVisible:true,loadingAfterNew:false,finalNew:true,finalOld:false});
  assert.equal(calls,2);assert.equal(f.root.querySelector('[data-page-task-search]'),input);assert.equal(input.value,'虚构');assert.equal(input.selectionStart,1);assert.equal(f.dom.window.document.activeElement,input);assert.equal(panel.scrollTop,73);
 }finally{release?.({kind:'found',value:[]});f.close();}
});

test('通知搜索在途时普通同查询搜索较新，迟到通知不能覆盖新结果',async()=>{
 const f=fixture();let release!:(value:unknown)=>void;try{await f.page.refresh();let calls=0,started!:()=>void,newer!:()=>void;const refreshStarted=new Promise<void>(resolve=>started=resolve),newerStarted=new Promise<void>(resolve=>newer=resolve);
  f.reader.search=async(query:string)=>{assert.equal(query,'虚构');calls++;if(calls===1){started();return new Promise(resolve=>release=resolve);}newer();return {kind:'found',value:[{...task('one'),title:'较新普通搜索标题'}]};};
  const input=f.root.querySelector<HTMLInputElement>('[data-page-task-search]')!;input.value='虚构';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));const refresh=f.page.refreshTasks();await refreshStarted;await newerStarted;await tick();
  release({kind:'found',value:[{...task('one'),title:'迟到通知旧标题'}]});await refresh;
  const final=f.root.querySelector('[data-page-task-results]')!.textContent||'';assert.match(final,/较新普通搜索标题/);assert.doesNotMatch(final,/迟到通知旧标题|正在搜索/);assert.equal(calls,2);assert.equal(f.root.querySelector('[data-page-task-search]'),input);
 }finally{release?.({kind:'found',value:[]});f.close();}
});

test('读取收尾任一微任务阶段收到通知，清理在途Promise时仍交接待处理刷新',async()=>{
 for(const offset of [0,3,7,10]){
  const f=fixture();try{await f.page.refresh();f.page.show({kind:'detail',workId:W,section:'tasks'});let calls=0,second:Promise<void>|undefined,requested!:()=>void;const notification=new Promise<void>(resolve=>requested=resolve);
   f.reader.getTask=async()=>{calls++;if(calls===1){let chain=Promise.resolve();for(let step=0;step<offset;step++)chain=chain.then(()=>{});void chain.then(()=>{second=f.page.refreshTasks();requested();});}return {kind:'found',value:task('one',calls>1)};};
   const first=f.page.refreshTasks();await notification;await first;await second;assert.equal(calls,2,`通知在微任务阶段 ${offset} 不应被收尾清理丢失`);assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/已完成 1\/1/);
  }finally{f.close();}
 }
});

// Native tab return must be driven by the actual panel/ancestor transition, never fake focus/update.
for(const hiding of ['panel-class','ancestor-class','ancestor-hidden','ancestor-style','ancestor-aria'] as const)test(`同窗口原生页签 ${hiding} 隐藏保存再显示，真实页面合并回读且保持查询焦点滚动`,async()=>{
 const f=fixture(),previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window:f.dom.window,document:f.dom.window.document});
 const host=f.dom.window.document.createElement('section');f.root.before(host);host.append(f.root);let registration:any;
 const tab=new WorkNativeTab({name:'fixture',app:{},addTab:(value:any)=>registration=value} as any,async()=>({} as any),()=>f.page);
 try{registration.init.call({element:f.root});await tick();
  f.reader.search=async()=>({kind:'found',value:[{...task('search'),documentId:W}]});const input=f.root.querySelector<HTMLInputElement>('[data-page-task-search]')!;input.value='虚构';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,180));input.focus();input.setSelectionRange(1,1);const panel=f.root.querySelector<HTMLElement>('.sac-work-page')!;panel.scrollTop=64;
  const target=hiding==='panel-class'?f.root:host;
  if(hiding.endsWith('class'))target.classList.add('fn__none');else if(hiding==='ancestor-hidden')target.hidden=true;else if(hiding==='ancestor-style')target.style.display='none';else target.setAttribute('aria-hidden','true');
  await tick();f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));f.dom.window.dispatchEvent(new f.dom.window.Event('reminderUpdated'));await tick();assert.deepEqual(f.reads,[]);
  if(hiding.endsWith('class'))target.classList.remove('fn__none');else if(hiding==='ancestor-hidden')target.hidden=false;else if(hiding==='ancestor-style')target.style.display='';else target.removeAttribute('aria-hidden');
  await tick();
  assert.deepEqual(f.reads,['one']);assert.match(f.root.querySelector('[data-task-progress]')!.textContent||'',/已完成 1\/1/);assert.equal(f.root.querySelector('[data-page-task-search]'),input);assert.equal(f.dom.window.document.activeElement,input);assert.equal(input.value,'虚构');assert.equal(input.selectionStart,1);assert.equal(panel.scrollTop,64);
  // A second return has no window/document event at all.
  target.classList.add('fn__none');await tick();target.classList.remove('fn__none');await tick();assert.deepEqual(f.reads,['one','one']);
 }finally{tab.dispose();f.close();Object.assign(globalThis,previous);}
});

for(const destination of ['same','removed','search','native','new-action'] as const)test(`主页任务结果迟到读取 ${destination} 按替换前焦点保留精确动作或可访问回退`,async()=>{
 const f=fixture();let release!:(value:unknown)=>void;try{
  const first={...task('one'),documentId:W},second={...task('two'),documentId:W};f.snapshot.recentTasks={kind:'found',value:[first,second]};await f.page.refresh();
  const results=f.root.querySelector<HTMLElement>('[data-page-task-results]')!,page=f.root.querySelector<HTMLElement>('.sac-work-page')!;results.scrollTop=33;page.scrollTop=78;
  const original=results.querySelector<HTMLButtonElement>('[data-task-id="one"][data-page-action="task"]')!;original.focus();f.reader.listRecent=()=>new Promise(resolve=>release=resolve);const refresh=f.page.refreshTasks();await tick();
  const external=destination==='search'?f.root.querySelector<HTMLInputElement>('[data-page-task-search]'):destination==='native'?f.dom.window.document.querySelector<HTMLInputElement>('#native'):null;
  if(external)external.focus();if(destination==='new-action')results.querySelector<HTMLButtonElement>('[data-task-id="two"]')!.focus();
  release({kind:'found',value:destination==='removed'?[second]:[second,first]});await refresh;
  if(external)assert.equal(f.dom.window.document.activeElement,external);
  else if(destination==='removed'){assert.equal(f.dom.window.document.activeElement,results);assert.equal(results.tabIndex,-1);assert.equal(results.getAttribute('aria-label'),'未完成任务结果');}
  else {const focused=f.dom.window.document.activeElement as HTMLElement;assert.equal(focused.dataset.taskId,destination==='new-action'?'two':'one');assert.equal(focused.dataset.pageAction,'task');assert.ok(results.contains(focused));}
  assert.equal(results.scrollTop,33);assert.equal(page.scrollTop,78);
 }finally{release?.({kind:'found',value:[]});f.close();}
});


test('原生页签替换实例忽略旧观察和排队读取，旧destroy不销毁新页且当前destroy解绑',async()=>{
 const first=fixture(),second=fixture(),previous={window:globalThis.window,document:globalThis.document};Object.assign(globalThis,{window:first.dom.window,document:first.dom.window.document});let registration:any;
 const tab=new WorkNativeTab({name:'fixture',app:{},addTab:(value:any)=>registration=value} as any,async()=>({} as any),element=>element===first.root?first.page:second.page);
 try{registration.init.call({element:first.root});await tick();first.dom.window.dispatchEvent(new first.dom.window.Event('reminderUpdated'));registration.init.call({element:second.root});await tick();assert.deepEqual(first.reads,[]);assert.deepEqual(second.reads,[]);
  registration.destroy.call({element:first.root});first.root.hidden=true;await tick();first.root.hidden=false;await tick();assert.deepEqual(second.reads,[]);
  second.page.show({kind:'detail',workId:W,section:'tasks'});const select=second.root.querySelector<HTMLSelectElement>('[data-work-next-status]')!;select.value='closed';select.focus();const panel=second.root.querySelector<HTMLElement>('.sac-work-page')!;panel.scrollTop=48;
  second.root.classList.add('fn__none');await tick();first.dom.window.dispatchEvent(new first.dom.window.Event('reminderUpdated'));await tick();assert.deepEqual(second.reads,[]);second.root.classList.remove('fn__none');await tick();assert.deepEqual(second.reads,['one']);assert.match(second.root.querySelector('[data-linked-tasks]')!.textContent||'',/已完成/);assert.equal(second.root.querySelector('[data-work-next-status]'),select);assert.equal(select.value,'closed');assert.equal(second.dom.window.document.activeElement,select);assert.equal(panel.scrollTop,48);
  registration.destroy.call({element:second.root});second.root.hidden=true;await tick();second.root.hidden=false;first.dom.window.dispatchEvent(new first.dom.window.Event('reminderUpdated'));await tick();assert.deepEqual(second.reads,['one']);
 }finally{tab.dispose();first.close();second.close();Object.assign(globalThis,previous);}
});
