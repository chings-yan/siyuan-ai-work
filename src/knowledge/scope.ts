export interface KnowledgeDocument { rootId: string; box: string; path: string; title: string }
export type KnowledgeScope = {kind:'documents'; documents:readonly KnowledgeDocument[]} | {kind:'all'};
const ID = /^\d{14}-[a-z0-9]{7}$/u;
export function isKnowledgeId(value:unknown):value is string {return typeof value==='string' && ID.test(value);}
export function validKnowledgeSource(rootId:unknown,box:unknown,path:unknown):boolean {
 return isKnowledgeId(rootId) && isKnowledgeId(box) && typeof path==='string' && path.startsWith('/') &&
  path.endsWith(`/${rootId}.sy`) && path.slice(1,-3).split('/').every(isKnowledgeId);
}
export function freezeKnowledgeScope(scope: KnowledgeScope): KnowledgeScope {
 if(!scope || typeof scope!=='object')throw Error('检索范围无效');
 if(scope.kind==='all')return Object.freeze({kind:'all'});
 if(scope.kind!=='documents'||!Array.isArray(scope.documents)||!scope.documents.length||scope.documents.length>200)throw Error('请先选择有效的文档或 Work 资料范围');
 const docs=new Map<string,KnowledgeDocument>();
 for(const doc of scope.documents){
  if(!doc || !validKnowledgeSource(doc.rootId,doc.box,doc.path)||typeof doc.title!=='string')throw Error('文档检索范围的来源未核实');
  const previous=docs.get(doc.rootId);
  if(previous&&(previous.box!==doc.box||previous.path!==doc.path))throw Error('文档检索范围存在身份冲突');
  docs.set(doc.rootId,Object.freeze({...doc}));
 }
 return Object.freeze({kind:'documents',documents:Object.freeze([...docs.values()])});
}
export function sourceInKnowledgeScope(scope:KnowledgeScope,source:{rootId:string;box:string;path:string}):boolean {
 return validKnowledgeSource(source.rootId,source.box,source.path) && (scope.kind==='all'||scope.documents.some(doc=>doc.rootId===source.rootId&&doc.box===source.box&&doc.path===source.path));
}
