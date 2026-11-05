type NamedDocument = { id:string; title:string };

export function documentLinkName(document:NamedDocument):string {
  const title=document.title.trim();
  return title&&title!==document.id?title:'当前文档（名称待核对）';
}

export function documentLinkConfirmation(document:NamedDocument,work:NamedDocument):string {
  const name=documentLinkName(document),title=work.title.trim();
  const knownTitle=document.title.trim()&&document.title.trim()!==document.id;
  const source=`资料文档：${name}${knownTitle?'':`\n文档 ID：${document.id}`}`;
  const target=`目标 Work：${title||'名称待核对'}${title?'':`\nWork ID：${work.id}`}`;
  return `关联当前文档为 Work 资料\n\n${source}\n${target}\n\n确认后，这篇文档会出现在该 Work 的资料列表中。原文档保留原位，当前对话保持不变。`;
}
