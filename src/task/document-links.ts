import {isValidDocumentRootId} from '../core.ts';

export type DocumentTaskLink={documentId:string;taskId:string;connectionId:'siyuan-native-local'};
export type DocumentTaskGuard={checkCurrent():void;validate():Promise<void>};
type Storage={loadData(key:string):Promise<unknown>;saveData(key:string,value:unknown):Promise<void>};
type Data={schema:1;links:DocumentTaskLink[]};
const KEY='ai-work-document-task-links-v1';
const taskIdValid=(id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=512&&id.trim()===id&&!/[\u0000-\u001f\u007f]/.test(id);
function checkedIdentity(documentId:string,taskId?:string):void {
  if(!isValidDocumentRootId(documentId)||taskId!==undefined&&!taskIdValid(taskId))throw Error('文档或任务标识无效，请重新核对。');
}
function parse(value:unknown):Data {
  if(value===undefined||value===null||value==='')return {schema:1,links:[]};
  const invalid=():never=>{throw Error('任务补充资料关联无法读取，请核对原数据；未覆盖已有记录。');};
  if(typeof value!=='object'||Array.isArray(value))return invalid();
  const data=value as Record<string,unknown>;
  if(data.schema!==1||!Array.isArray(data.links)||Object.keys(data).some(k=>!['schema','links'].includes(k)))return invalid();
  const seen=new Set<string>();const links:DocumentTaskLink[]=[];
  for(const item of data.links){
    if(!item||typeof item!=='object'||Array.isArray(item))return invalid();
    const link=item as Record<string,unknown>;
    if(!isValidDocumentRootId(link.documentId)||!taskIdValid(link.taskId)||link.connectionId!=='siyuan-native-local'||Object.keys(link).some(k=>!['documentId','taskId','connectionId'].includes(k)))return invalid();
    const key=JSON.stringify([link.documentId,link.taskId]);if(seen.has(key))return invalid();seen.add(key);
    links.push({documentId:link.documentId,taskId:link.taskId,connectionId:'siyuan-native-local'});
  }
  return {schema:1,links};
}

/** AI Work supplemental references only; task-owned primary documents and Work task ownership stay separate. */
export class DocumentTaskLinks {
  private writes:Promise<void>=Promise.resolve();
  constructor(private readonly storage:Storage){}
  private async read():Promise<Data>{return parse(await this.storage.loadData(KEY));}
  async list(documentId:string):Promise<DocumentTaskLink[]>{checkedIdentity(documentId);return (await this.read()).links.filter(link=>link.documentId===documentId);}
  link(documentId:string,taskId:string,guard:DocumentTaskGuard):Promise<void>{return this.change(documentId,taskId,true,guard);}
  unlink(documentId:string,taskId:string,guard:DocumentTaskGuard):Promise<void>{return this.change(documentId,taskId,false,guard);}
  private change(documentId:string,taskId:string,add:boolean,guard:DocumentTaskGuard):Promise<void>{
    const next=this.writes.then(async()=>{
      checkedIdentity(documentId,taskId);guard.checkCurrent();
      await this.read();guard.checkCurrent();await guard.validate();guard.checkCurrent();
      const data=await this.read();guard.checkCurrent();
      const index=data.links.findIndex(link=>link.documentId===documentId&&link.taskId===taskId);
      if(add&&index>=0||!add&&index<0)return;
      // The final relation read may suspend after the first source check.
      // Revalidate the selected source last, with no intervening read before save.
      await guard.validate();guard.checkCurrent();
      if(add)data.links.push({documentId,taskId,connectionId:'siyuan-native-local'});else data.links.splice(index,1);
      await this.storage.saveData(KEY,data);
      if(JSON.stringify(await this.read())!==JSON.stringify(data))throw Error('任务补充资料关联结果待核对，未能读回一致记录；请刷新核对，勿重复操作。');
    });
    this.writes=next.catch(()=>{});return next;
  }
}
