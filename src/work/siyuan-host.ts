import { isValidDocumentRootId } from '../core.ts';
import type { WorkHost } from './service.ts';
import type { ExistingDocument, Notebook } from './create.ts';

export type SiYuanApi = (path: string, body: Record<string, unknown>) => Promise<unknown>;
function row(value: unknown): Record<string, unknown> | null { return Array.isArray(value) && value[0] && typeof value[0] === 'object' ? value[0] as Record<string, unknown> : null; }
function requireId(id: string): void { if (!isValidDocumentRootId(id)) throw new Error('无效的思源文档 ID'); }
function nativeKramdown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length) return nativeKramdown(value[0]);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ['kramdown', 'markdown', 'content']) if (key in record) return nativeKramdown(record[key]);
  }
  throw new Error('块正文读取返回格式错误，请重试');
}

export class SiYuanWorkHost implements WorkHost {
  constructor(private readonly api: SiYuanApi, private readonly creationTimeoutMs = 12000) {}
  private async creationRead<T>(promise: Promise<T>, timeoutMessage = '创建接口超时，结果未知；请核对，不要重新提交'): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(timeoutMessage)),this.creationTimeoutMs);})]); }
    finally { if(timer)clearTimeout(timer); }
  }
  async getAttrs(id: string): Promise<Record<string, string>> {
    const value = await this.api('/api/attr/getBlockAttrs', { id });
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error('块属性读取返回格式错误，请重试');
    return value as Record<string,string>;
  }
  async setAttrs(id: string, attrs: Record<string, string>): Promise<void> { await this.api('/api/attr/setBlockAttrs', { id, attrs }); }
  async getChildren(id: string): Promise<string[]> {
    const value = await this.api('/api/block/getChildBlocks', { id });
    if (!Array.isArray(value) || value.some(x => !isValidDocumentRootId(x?.id))) throw new Error('子块读取返回格式错误，请重试');
    return value.map(x => x.id);
  }
  async getBlockMarkdown(id: string): Promise<string> { return nativeKramdown(await this.api('/api/block/getBlockKramdown', { id })); }
  async prependMarkdown(parentId: string, markdown: string): Promise<void> {
    requireId(parentId);
    await this.api('/api/block/prependBlock', { dataType: 'markdown', data: markdown, parentID: parentId });
  }
  async appendMarkdown(parentId: string, markdown: string): Promise<void> {
    requireId(parentId);
    await this.api('/api/block/appendBlock', { dataType: 'markdown', data: markdown, parentID: parentId });
  }
  async getDocumentPath(id: string): Promise<string | null> {
    requireId(id);
    const value = await this.api('/api/query/sql', { stmt: `select path from blocks where id = '${id}' and type = 'd' limit 1` });
    // Only a successful empty SQL result proves absence; malformed reads must remain retryable.
    if (!Array.isArray(value)) throw new Error('文档路径读取返回格式错误，请重试');
    if (value.length === 0) return null;
    const found = row(value);
    const path = found?.path;
    if (value.length !== 1 || typeof path !== 'string' || !path.startsWith('/') || !path.endsWith(`/${id}.sy`) ||
        !path.slice(1, -3).split('/').every(isValidDocumentRootId)) throw new Error('文档路径读取返回格式错误，请重试');
    return path;
  }
  async getDocumentTitle(id: string): Promise<string> {
    requireId(id);
    const found = row(await this.api('/api/query/sql', { stmt: `select content from blocks where id = '${id}' and type = 'd' limit 1` }));
    return typeof found?.content === 'string' ? found.content : '';
  }
  async searchDocuments(query: string, notebooks: string[]): Promise<ExistingDocument[]> {
    const phrase = query.trim();
    if (!phrase || phrase.length > 100 || !notebooks.length) return [];
    for (const notebook of notebooks) requireId(notebook);
    const quoted = phrase.replace(/'/g,"''");
    const boxes = [...new Set(notebooks)].map(id=>`'${id}'`).join(',');
    const value = await this.creationRead(this.api('/api/query/sql', {stmt:`select id, content, box from blocks where type = 'd' and box in (${boxes}) and instr(content, '${quoted}') > 0 order by updated desc limit 30`}), '文档搜索超时，请检查思源连接后重试');
    if (!Array.isArray(value) || value.length > 30 || value.some(r=>!isValidDocumentRootId(r?.id)||typeof r?.content!=='string'||!notebooks.includes(r?.box))) throw new Error('现有文档搜索结果格式错误');
    return value.map(r=>({id:r.id,title:r.content,notebookId:r.box}));
  }
  async getDocumentMarkdown(id: string): Promise<string> {
    requireId(id);
    const value = await this.api('/api/export/exportMdContent', { id });
    if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).content !== 'string') throw new Error('无法读取完整文档');
    return (value as { content: string }).content;
  }
  async getDocumentRoot(id: string): Promise<string | null> {
    if (!isValidDocumentRootId(id)) return null;
    const found = row(await this.api('/api/query/sql', { stmt: `select root_id from blocks where id = '${id}' limit 1` }));
    return typeof found?.root_id === 'string' ? found.root_id : null;
  }
  async listDescendantDocuments(workId: string): Promise<string[]> {
    requireId(workId);
    const path = await this.getDocumentPath(workId);
    if (!path || !path.endsWith('.sy')) throw new Error('Work 路径暂不可读取');
    const prefix = path.slice(0, -3).replace(/'/g, "''") + '/';
    const value = await this.api('/api/query/sql', { stmt: `select id from blocks where type = 'd' and path like '${prefix}%' order by path limit 201` });
    if (!Array.isArray(value) || value.some(item => !isValidDocumentRootId(item?.id))) throw new Error('文档目录读取格式错误');
    if (value.length > 200) throw new Error('文档目录过多，暂不能完整读取或统计');
    return value.map(item => item.id);
  }
  async listNotebooks(): Promise<Notebook[]> {
    const value = await this.creationRead(this.api('/api/notebook/lsNotebooks', {})) as { notebooks?: unknown };
    if (!Array.isArray(value?.notebooks) || value.notebooks.some(n => !isValidDocumentRootId(n?.id) || typeof n.name !== 'string' || typeof n.closed !== 'boolean')) throw new Error('笔记本列表读取格式错误');
    return value.notebooks.filter(n => !n.closed).map(n => ({id:n.id,name:n.name}));
  }
  async getDocumentNotebook(id: string): Promise<string> {
    requireId(id);
    const value = await this.creationRead(this.api('/api/query/sql', {stmt:`select box from blocks where id = '${id}' and type = 'd' limit 1`}));
    if (!Array.isArray(value) || value.length !== 1 || !isValidDocumentRootId(value[0]?.box)) throw new Error('文档所在笔记本暂不可读取');
    return value[0].box;
  }
  async getDocumentIdsByPath(notebook: string, title: string): Promise<string[]> {
    requireId(notebook);
    const value = await this.creationRead(this.api('/api/filetree/getIDsByHPath', {notebook,path:`/${title}`}));
    if (!Array.isArray(value) || value.some(id => !isValidDocumentRootId(id))) throw new Error('同名文档检查返回格式错误');
    return value;
  }
  async createDocument(notebook: string, title: string, operation: string): Promise<string> {
    requireId(notebook);
    if (!/^work-create:[a-f0-9-]+$/u.test(operation)) throw new Error('无效的创建操作标记');
    const value = await this.creationRead(this.api('/api/filetree/createDocWithMd', {notebook,path:`/${title}`,markdown:`Work 创建记录\n{: custom-ai-work-create-op="${operation}"}`}));
    if (!isValidDocumentRootId(value)) throw new Error('原生创建未返回有效文档 ID，结果未知');
    return value;
  }
  async findCreatedDocuments(notebook: string, operation: string): Promise<string[]> {
    requireId(notebook);
    if (!/^work-create:[a-f0-9-]+$/u.test(operation)) throw new Error('无效的创建操作标记');
    // SiYuan 3.8.5 exports omit custom IAL attributes; use persisted attrs, never exported Markdown.
    const value = await this.creationRead(this.api('/api/query/sql', {stmt:`select block_id, root_id from attributes where box = '${notebook}' and name = 'custom-ai-work-create-op' and value = '${operation}' limit 101`}));
    if (!Array.isArray(value) || value.length > 100 || value.some(r => !isValidDocumentRootId(r?.block_id) || !isValidDocumentRootId(r?.root_id))) throw new Error('创建标记读取格式错误或结果过多');
    const roots = [...new Set<string>(value.map(r => r.root_id))];
    if (roots.length !== 1) return roots;
    for (const r of value) {
      if ((await this.creationRead(this.getAttrs(r.block_id)))['custom-ai-work-create-op'] !== operation || await this.creationRead(this.getDocumentRoot(r.block_id)) !== r.root_id || await this.getDocumentNotebook(r.root_id) !== notebook) throw new Error('创建标记与文档直接读回不一致，请稍后核对');
    }
    return roots;
  }
}
