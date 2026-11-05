import { isValidDocumentRootId } from '../core.ts';
import type { SessionChat } from './sessions.ts';
import type { WorkRecord } from './service.ts';
import type { ChatLink, TaskLink, ResumeState } from './store.ts';
import type { RoomLink } from './room-store.ts';
import type { NativeTaskReader, TaskLookup } from '../task/reader.ts';

export type CatalogRead<T> = { value: T; error?: never } | { value?: never; error: string };
export type CatalogDocument = { id: string; title: CatalogRead<string>; kind: 'root' | 'child' | 'external' };
export type CatalogWork = {
  id: string; record: CatalogRead<WorkRecord>; resume: CatalogRead<ResumeState | null>;
  documents: CatalogRead<CatalogDocument[]>; tasks: CatalogRead<(TaskLink & { lookup: TaskLookup })[]>;
  chats: CatalogRead<SessionChat[]>; rooms: CatalogRead<RoomLink[]>;
};
export type CatalogSnapshot = { works: CatalogWork[]; continueWorks: CatalogWork[]; recentTasks: Awaited<ReturnType<NativeTaskReader['listRecent']>>; error?: string };
// Structural ports keep the catalog independent of the formal relationship schema.
export type CatalogPorts = {
  store: { listWorks(): Promise<string[]>; getResume(id: string): Promise<ResumeState | null>; listChats(id: string): Promise<SessionChat[]>; listTasks(id: string): Promise<TaskLink[]> };
  service: { readWork(id: string): Promise<WorkRecord | null>; listExternalDocuments(id: string): Promise<string[]> };
  host: { getDocumentPath(id: string): Promise<string | null>; getDocumentTitle(id: string): Promise<string>; listDescendantDocuments(id: string): Promise<string[]> };
  rooms: { listForWork(id: string): Promise<RoomLink[]> };
  taskReader: Pick<NativeTaskReader, 'listRecent' | 'getTask'>;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
async function read<T>(operation: () => Promise<T>): Promise<CatalogRead<T>> {
  try { return { value: await operation() }; } catch (error) { return { error: message(error) }; }
}

export class WorkCatalog {
  constructor(private readonly ports: CatalogPorts) {}
  private async work(id: string): Promise<CatalogWork> {
    const { store, host, service, rooms, taskReader } = this.ports;
    const [record, resume, documents, tasks, chats, roomLinks] = await Promise.all([
      read(async () => { const work = await service.readWork(id); if (!work) throw new Error('Work 文档缺失或标记已移除，请核对'); return work; }),
      read(async () => {
        const saved = await store.getResume(id);
        if (!saved || saved.workId !== id || !isValidDocumentRootId(saved.documentId) || !Number.isFinite(Date.parse(saved.updatedAt))) return null;
        return await host.getDocumentPath(saved.documentId) ? saved : null;
      }),
      read(async () => {
        const [children, external] = await Promise.all([host.listDescendantDocuments(id), service.listExternalDocuments(id)]);
        return Promise.all([...new Set([id, ...children, ...external])].map(async documentId => ({ id: documentId,
          title: await read(async () => { const title = await host.getDocumentTitle(documentId); if (!title) throw new Error('文档名称暂不可读取'); return title; }),
          kind: documentId === id ? 'root' as const : children.includes(documentId) ? 'child' as const : 'external' as const,
        })));
      }),
      read(async () => Promise.all((await store.listTasks(id)).map(async link => ({ ...link,
        lookup: link.connectionId === 'siyuan-native-local' ? await taskReader.getTask(link.taskId) : { kind: 'unavailable' as const, reason: '任务属于其他连接，请在原连接核对' },
      })))),
      read(() => store.listChats(id)), read(() => rooms.listForWork(id)),
    ]);
    return { id, record, resume, documents, tasks, chats, rooms: roomLinks };
  }
  async load(): Promise<CatalogSnapshot> {
    const [ids, recent] = await Promise.all([read(() => this.ports.store.listWorks()), read(() => this.ports.taskReader.listRecent(5))]);
    const recentTasks = recent.value ?? { kind: 'unavailable' as const, reason: recent.error! };
    if (ids.error) return { works: [], continueWorks: [], recentTasks, error: ids.error };
    const works = await Promise.all(ids.value!.map(id => this.work(id)));
    const continueWorks = works.filter(row => row.record.value?.status === 'active' && row.resume.value)
      .sort((a,b) => Date.parse(b.resume.value!.updatedAt) - Date.parse(a.resume.value!.updatedAt));
    return { works, continueWorks, recentTasks };
  }
}
