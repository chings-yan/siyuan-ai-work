import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'siyuan';
import { NativeTaskEditor } from '../src/task/edit.ts';
const ID='recurring_exact_2026-11-05',BLOCK='20261105120000-aaaaaaa';
function fixture(){
 const app:any={plugins:[]},calls:unknown[][]=[];
 const plugin:any={app,name:'siyuan-plugin-task-note-management',openReminderEditDialog:async function(...args:unknown[]){assert.equal(this,plugin);calls.push(args);return true;}};app.plugins.push(plugin);
 const task:any={id:ID,title:'虚构待办',completed:false,documentId:'20261105120001-bbbbbbb',projectId:null,createdAt:'',blockId:BLOCK};
 let reads=0;const reader:any={getTask:async(id:string)=>{assert.equal(id,ID);reads++;return {kind:'found',value:task};}};
 const editor=new NativeTaskEditor(app as App,reader,{commandTimeoutMs:15});
 return {app,plugin,calls,task,reader,editor,reads:()=>reads};
}
const request=()=>({taskId:ID,isCurrent:()=>true});
test('精确任务重读后只传原块与完整任务ID，原生返回不声明保存成功',async()=>{
 const f=fixture();const result=await f.editor.open(request());assert.equal(result.kind,'opened');assert.deepEqual(f.calls,[[BLOCK,ID]]);assert.equal(f.reads(),1);assert.match(result.reason,/发起/);assert.match(result.reason,/不表示.*保存|不代表.*保存/);
});
for(const blockId of [undefined,null,''])test(`无块 ${String(blockId)} 只传空字符串，不借用文档`,async()=>{
 const f=fixture();f.task.blockId=blockId;assert.equal((await f.editor.open(request())).kind,'opened');assert.deepEqual(f.calls,[['',ID]]);
});
for(const change of ['absent','other-app','method-missing','similar-name','wrong-id','bad-block','missing','unavailable'] as const)test(`原生编辑拒绝 ${change}`,async()=>{
 const f=fixture();if(change==='absent')f.app.plugins=[];if(change==='other-app')f.plugin.app={};if(change==='method-missing')delete f.plugin.openReminderEditDialog;if(change==='similar-name')f.plugin.name+='-other';if(change==='wrong-id')f.task.id='series';if(change==='bad-block')f.task.blockId='bad';if(change==='missing'||change==='unavailable')f.reader.getTask=async()=>({kind:change,reason:'offline'});
 assert.equal((await f.editor.open(request())).kind,'blocked');assert.deepEqual(f.calls,[]);
});
for(const change of ['method','instance','page'] as const)test(`重读期间 ${change} 改变阻止调用`,async()=>{
 const f=fixture();let current=true;f.reader.getTask=async()=>{if(change==='method')f.plugin.openReminderEditDialog=async()=>true;if(change==='instance')f.app.plugins=[{...f.plugin}];if(change==='page')current=false;return {kind:'found',value:f.task};};
 assert.equal((await f.editor.open({taskId:ID,isCurrent:()=>current})).kind,'blocked');assert.deepEqual(f.calls,[]);
});
test('同步锁阻止双击，读取尚未完成时不能发起第二个调用',async()=>{
 const f=fixture();let finish!:(value:unknown)=>void;f.reader.getTask=()=>new Promise(resolve=>finish=resolve);
 const first=f.editor.open(request());const second=await f.editor.open(request());assert.equal(second.kind,'blocked');assert.deepEqual(f.calls,[]);finish({kind:'found',value:f.task});assert.equal((await first).kind,'opened');assert.equal(f.calls.length,1);
});
test('原生明确false可报告阻止，之后用户可重新操作',async()=>{
 const f=fixture();f.plugin.openReminderEditDialog=()=>false;assert.equal((await f.editor.open(request())).kind,'blocked');f.plugin.openReminderEditDialog=()=>true;assert.equal((await f.editor.open(request())).kind,'opened');
});
for(const outcome of ['throw','reject','timeout','stale-after-call','method-after-call','nonboolean'] as const)test(`调用后 ${outcome} 结果未知，迟到与再次点击不重试`,async()=>{
 const f=fixture();let current=true,invoked=0,finish!:(v:boolean)=>void;
 f.plugin.openReminderEditDialog=()=>{invoked++;if(outcome==='throw')throw Error('oops');if(outcome==='reject')return Promise.reject(Error('oops'));if(outcome==='timeout')return new Promise<boolean>(resolve=>finish=resolve);if(outcome==='stale-after-call')current=false;if(outcome==='method-after-call')f.plugin.openReminderEditDialog=()=>true;return outcome==='nonboolean'?undefined:true;};
 const result=await f.editor.open({taskId:ID,isCurrent:()=>current});assert.equal(result.kind,'unknown');if(finish)finish(true);await Promise.resolve();current=true;assert.equal((await f.editor.open(request())).kind,'unknown');assert.equal(invoked,1);
});
