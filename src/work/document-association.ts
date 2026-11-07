import {isValidDocumentRootId} from '../core.ts';
import {DocumentTaskLinks} from '../task/document-links.ts';
import type {NativeTaskReader,TaskLookup,TaskView} from '../task/reader.ts';
import type {WorkService,WorkStatus} from './service.ts';
import type {WorkStore} from './store.ts';

export type AssociationDocument={id:string;title:string};
export type AssociationWork={id:string;title:string;goal:string;status?:WorkStatus;relation:'root'|'child'|'reference'|'none';error?:string};
export type AssociatedTask={taskId:string;task:TaskLookup};
type Options={
 currentDocumentId():string|null;isBusy():boolean;taskLinks:DocumentTaskLinks;
 taskReader:Pick<NativeTaskReader,'getTask'>;store:Pick<WorkStore,'listWorks'>;
 host:{getDocumentPath(id:string):Promise<string|null>;listDescendantDocuments(id:string):Promise<string[]>};
 service:Pick<WorkService,'readWork'|'listExternalDocuments'|'linkExternalDocument'>;
};
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const taskSelection=(t:TaskView)=>JSON.stringify([t.id,t.title,t.documentId,t.projectId,t.completed,t.blockId??null,t.customProgress??null,t.kanbanStatus??null]);

/** Supplemental document links do not change native task ownership or the current conversation. */
export class DocumentAssociations {
 constructor(private readonly options:Options){}
 private check(documentId:string,isCurrent:()=>boolean):void{
  if(!isValidDocumentRootId(documentId)||!isCurrent()||this.options.currentDocumentId()!==documentId)throw Error('当前文档或页面已变化，请重新核对关联目标。');
  if(this.options.isBusy())throw Error('请先完成当前生成、发送、导航或待处理修改，再关联资料。');
 }
 private async checkDocument(documentId:string,isCurrent:()=>boolean):Promise<void>{
  this.check(documentId,isCurrent);const path=await this.options.host.getDocumentPath(documentId);this.check(documentId,isCurrent);
  if(!path)throw Error('当前文档不存在或暂不可读取，未修改关联。');
 }
 async listWorks(documentId:string):Promise<AssociationWork[]>{
  if(!isValidDocumentRootId(documentId))throw Error('请先打开思源文档。');
  return Promise.all((await this.options.store.listWorks()).map(async id=>{
   try{
    const work=await this.options.service.readWork(id);if(!work)throw Error('Work 文档缺失或标记已移除，请核对。');
    const relation=id===documentId?'root':(await this.options.host.listDescendantDocuments(id)).includes(documentId)?'child':(await this.options.service.listExternalDocuments(id)).includes(documentId)?'reference':'none';
    return {...work,relation} as AssociationWork;
   }catch(e){return {id,title:'暂不可读的 Work',goal:'',relation:'none' as const,error:errorText(e)};}
  }));
 }
 async listTaskLinks(documentId:string):Promise<AssociatedTask[]>{
  return Promise.all((await this.options.taskLinks.list(documentId)).map(async link=>{
   let task:TaskLookup;try{task=await this.options.taskReader.getTask(link.taskId);}catch(e){task={kind:'unavailable',reason:errorText(e)};}
   return {taskId:link.taskId,task};
  }));
 }
 async linkTask(documentId:string,selected:TaskView,isCurrent:()=>boolean):Promise<void>{
  const expected=taskSelection(selected);
  await this.options.taskLinks.link(documentId,selected.id,{checkCurrent:()=>this.check(documentId,isCurrent),validate:async()=>{
   await this.checkDocument(documentId,isCurrent);const task=await this.options.taskReader.getTask(selected.id);this.check(documentId,isCurrent);
   if(task.kind!=='found')throw Error('原任务不存在或暂不可读，请在任务插件核对后再关联。');
   if(task.value.completed||taskSelection(task.value)!==expected)throw Error('原任务名称、主文档或进度已变化，请刷新后重新选择。');
  }});
 }
 async unlinkTask(documentId:string,taskId:string,isCurrent:()=>boolean):Promise<void>{
  await this.options.taskLinks.unlink(documentId,taskId,{checkCurrent:()=>this.check(documentId,isCurrent),validate:()=>this.checkDocument(documentId,isCurrent)});
 }
 async checkTaskLink(documentId:string,taskId:string,isCurrent:()=>boolean):Promise<void>{
  await this.checkDocument(documentId,isCurrent);const links=await this.options.taskLinks.list(documentId);this.check(documentId,isCurrent);
  if(!links.some(link=>link.taskId===taskId))throw Error('当前文档与任务的补充资料关联已变化，请刷新核对。');
 }
 async linkWork(documentId:string,selected:AssociationWork,isCurrent:()=>boolean):Promise<void>{
  await this.checkDocument(documentId,isCurrent);
  const work=await this.options.service.readWork(selected.id);this.check(documentId,isCurrent);
  if(!work||selected.error||work.title!==selected.title||work.goal!==selected.goal||work.status!==selected.status)throw Error('Work 已变化或无法读取，请刷新后重新选择。');
  if(selected.id===documentId)return;
  const children=await this.options.host.listDescendantDocuments(selected.id);this.check(documentId,isCurrent);if(children.includes(documentId))return;
  if((await this.options.service.listExternalDocuments(selected.id)).includes(documentId)){this.check(documentId,isCurrent);return;}
  this.check(documentId,isCurrent);
  await this.options.service.linkExternalDocument(selected.id,documentId,true,()=>this.check(documentId,isCurrent),async()=>{
   const fresh=await this.options.service.readWork(selected.id);this.check(documentId,isCurrent);
   if(!fresh||fresh.title!==selected.title||fresh.goal!==selected.goal||fresh.status!==selected.status)throw Error('所选 Work 已变化，请刷新后重新确认。');
   const children=await this.options.host.listDescendantDocuments(selected.id);this.check(documentId,isCurrent);
   if(children.includes(documentId))throw Error('当前文档已成为 Work 子文档，请刷新查看；未重复添加资料。');
  });
 }
}
