import type { App, Plugin } from 'siyuan';
import type { NativeTaskReader } from './reader.ts';
export type TaskEditResult={kind:'opened'|'blocked'|'unknown';reason:string};
type EditorPlugin=Plugin & {openReminderEditDialog:(blockId:string,taskId:string)=>unknown};
const stale='页面或 Work 已变化，请重新核对任务。';
/** 只发起精确原生编辑；原生 true 是入口回执，不能证明保存。 */
export class NativeTaskEditor {
 private pending=false;
 private unknown=new Map<string,TaskEditResult>();
 private readonly timeoutMs:number;
 constructor(private readonly app:App,private readonly reader:Pick<NativeTaskReader,'getTask'>,dependencies:{commandTimeoutMs?:number}={}){
  this.timeoutMs=Number.isFinite(dependencies.commandTimeoutMs)?Math.max(1,Math.min(30000,dependencies.commandTimeoutMs!)):8000;
 }
 private capability():EditorPlugin {
  const plugin=this.app.plugins?.find(item=>item.name==='siyuan-plugin-task-note-management'&&item.app===this.app) as EditorPlugin|undefined;
  if(!plugin||typeof plugin.openReminderEditDialog!=='function')throw Error('当前窗口的任务插件未提供原生编辑入口，请启用或更新插件后核对。');
  return plugin;
 }
 async open(request:{taskId:string;isCurrent:()=>boolean}):Promise<TaskEditResult>{
  const taskId=request.taskId,current=request.isCurrent;
  const unknown=this.unknown.get(taskId);if(unknown)return unknown;
  if(this.pending)return {kind:'blocked',reason:'正在打开任务，请勿重复发起。'};
  this.pending=true;
  let invoked=false,timer:ReturnType<typeof setTimeout>|undefined;
  try{
   if(!taskId.trim()||taskId.trim()!==taskId)throw Error('任务 ID 无效，请重新核对。');
   if(!current())throw Error(stale);
   const plugin=this.capability(),method=plugin.openReminderEditDialog;
   const lookup=await this.reader.getTask(taskId);
   if(!current())throw Error(stale);
   if(lookup.kind!=='found')throw Error(lookup.kind==='missing'?'任务已不存在，保留关联供核对。':lookup.reason);
   if(lookup.value.id!==taskId)throw Error('任务 ID 已变化，请重新核对。');
   const blockId=lookup.value.blockId;
   if(blockId!==undefined&&blockId!==null&&blockId!==''&&(typeof blockId!=='string'||!/^\d{14}-[a-z0-9]{7}$/.test(blockId)))throw Error('任务原始块无效，已停止打开。');
   const latest=this.capability();if(latest!==plugin||latest.openReminderEditDialog!==method)throw Error('任务插件入口已变化，请重新核对。');
   if(!current())throw Error(stale);
   invoked=true;
   const result=await Promise.race([Promise.resolve(method.call(plugin,blockId??'',taskId)),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),this.timeoutMs);})]);
   if(!current())throw Error(stale);
   const after=this.capability();if(after!==plugin||after.openReminderEditDialog!==method)throw Error('任务插件入口已变化');
   if(result===false)return {kind:'blocked',reason:'任务插件未打开编辑器，请到原插件核对这项任务。'};
   if(result!==true)throw Error('原生入口回执无法核对');
   return {kind:'opened',reason:'已发起打开原生任务编辑器，请在原插件编辑并保存；此返回不表示任务已保存。'};
  }catch(error){
   if(invoked){const result:TaskEditResult={kind:'unknown',reason:'任务编辑入口已发起，但结果未知。请先到原插件核对，不要重复发起。'};this.unknown.set(taskId,result);return result;}
   return {kind:'blocked',reason:error instanceof Error?error.message:'任务核对失败，请重新核对。'};
  }finally{if(timer!==undefined)clearTimeout(timer);this.pending=false;}
 }
}
