export type TaskView = { id: string; title: string; completed: boolean; documentId: string | null; projectId: string | null; createdAt: string };
export type TaskLookup = { kind: 'found'; value: TaskView } | { kind: 'missing' } | { kind: 'unavailable'; reason: string };
export type TaskList = {kind:'found';value:TaskView[]} | {kind:'unavailable';reason:string};
type RpcResponse = { result?: { tools?: { name: string }[]; structuredContent?: unknown; content?: { type: string; text?: string }[] }; error?: { message?: string } };
type Transport = typeof fetch;
const PREFIX = 'plugin__siyuan_plugin_task_note_management__task__';
// 当前任务插件先截取 limit 再返回，需取全一个有界窗口才能按创建时间可靠排序。
const RECENT_SCAN_LIMIT = 1001;
class TaskMissingError extends Error {}
function taskView(value: unknown): TaskView | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.title !== 'string') return null;
  return { id: item.id, title: item.title, completed: item.completed === true, documentId: typeof item.docId === 'string' && item.docId ? item.docId : null, projectId: typeof item.projectId === 'string' && item.projectId ? item.projectId : null, createdAt: typeof item.createdAt === 'string' ? item.createdAt : '' };
}
export function shouldClearCurrentTask(currentId: string | null, checkedId: string, result: TaskLookup): boolean {
  return currentId === checkedId && (result.kind === 'missing' || (result.kind === 'found' && result.value.completed));
}
export class NativeTaskReader {
  constructor(private readonly transport: Transport = fetch, private readonly endpoint = '/mcp') {}
  private async call(action: 'search_task' | 'get_task', args: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 8000);
    let session = '';
    const send = async (id: number, method: string, params: Record<string, unknown>) => {
      const response = await this.transport(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal });
      if (!response.ok) throw new Error(`思源 MCP ${response.status}`);
      if (!session) session = response.headers.get('Mcp-Session-Id') || '';
      const value = await response.json() as RpcResponse;
      if (value.error) throw new Error(value.error.message || '思源 MCP 返回错误');
      return value.result;
    };
    try {
      await send(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'siyuan-ai-work', version: '0.2.0' } });
      const listed = await send(2, 'tools/list', {});
      const tool = listed?.tools?.find(x => x.name.startsWith(PREFIX));
      if (!tool) throw new Error('任务笔记管理 MCP 工具未注册');
      const result = await send(3, 'tools/call', { name: tool.name, arguments: { action, ...args } });
      const structured = result?.structuredContent ?? JSON.parse(result?.content?.find(x => x.type === 'text')?.text || '{}');
      if (!structured || typeof structured !== 'object') throw new Error('任务插件返回格式错误');
      const record = structured as Record<string, unknown>;
      if (record.success !== true) {
        const message = String(record.error || record.message || '任务插件读取失败');
        if (action === 'get_task' && message.startsWith('任务不存在:')) throw new TaskMissingError(message);
        throw new Error(message);
      }
      return record.data;
    } finally { clearTimeout(timeout); }
  }
  async listRecent(limit = 5): Promise<TaskList> { return this.search('',limit); }
  async search(query: string, limit = 30): Promise<TaskList> {
    try {
      const keyword=query.trim();if(keyword.length>100)throw new Error('搜索关键字不能超过 100 字');
      const data = await this.call('search_task', { completed: false, limit: RECENT_SCAN_LIMIT, ...(keyword?{keyword}:{}) });
      if (!Array.isArray(data)) throw new Error('任务列表格式错误');
      if (data.length >= RECENT_SCAN_LIMIT) throw new Error(keyword?'匹配任务超过 1000 条，请缩小搜索范围':'未完成任务超过 1000 条，无法可靠推荐最近任务');
      const tasks = data.map(taskView).filter((x): x is TaskView => x !== null && !x.completed);
      tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { kind: 'found', value: tasks.slice(0, Math.max(1, Math.min(50, limit))) };
    } catch (error) { return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }; }
  }
  async getTask(id: string): Promise<TaskLookup> {
    try { const data = await this.call('get_task', { id }); const value = taskView(data); if(value&&value.id!==id)throw new Error('任务接口返回的 ID 不一致，已停止操作，请重新核对');return value ? { kind: 'found', value } : { kind: 'missing' }; }
    catch (error) { return error instanceof TaskMissingError ? { kind: 'missing' } : { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }; }
  }
}
