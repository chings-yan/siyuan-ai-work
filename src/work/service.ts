import { isValidDocumentRootId, normalizeForReadback } from '../core.ts';
import { WorkStore } from './store.ts';

export type WorkStatus = 'active' | 'paused' | 'completed' | 'closed';
export type WorkRecord = { id: string; title: string; goal: string; status: WorkStatus };
export class WorkGoalError extends Error {
  constructor(readonly workId: string, readonly goalCount: number) { super('Work 目标角色块重复，已停止更新'); }
}
export type WorkHost = {
  getAttrs(id: string): Promise<Record<string, string>>;
  setAttrs(id: string, attrs: Record<string, string>): Promise<void>;
  getChildren(id: string): Promise<string[]>;
  getBlockMarkdown(id: string): Promise<string>;
  prependMarkdown(parentId: string, markdown: string): Promise<void>;
  appendMarkdown(parentId: string, markdown: string): Promise<void>;
  getDocumentPath(id: string): Promise<string | null>;
  getDocumentTitle(id: string): Promise<string>;
};

export class WorkService {
  private externalLinks: Promise<void> = Promise.resolve();
  constructor(private readonly host: WorkHost, private readonly store: WorkStore) {}
  private async roleBlocks(workId: string, role: string): Promise<{ id: string; attrs: Record<string, string> }[]> {
    const ids = await this.host.getChildren(workId);
    const rows = await Promise.all(ids.map(async id => ({ id, attrs: await this.host.getAttrs(id) })));
    return rows.filter(row => row.attrs['custom-ai-work-role'] === role);
  }
  async readWork(workId: string): Promise<WorkRecord | null> {
    if (!isValidDocumentRootId(workId)) return null;
    const attrs = await this.host.getAttrs(workId);
    if (attrs['custom-ai-work-v0'] !== '1') return null;
    const goals = await this.roleBlocks(workId, 'goal');
    if (goals.length > 1) throw new WorkGoalError(workId, goals.length);
    const markdown = goals.length ? await this.host.getBlockMarkdown(goals[0].id) : '';
    const goal = markdown.replace(/\n\{:[^}]*\}\s*$/u, '').replace(/^\*\*目标\*\*：/u, '').trim();
    if (goals.length && !goal) throw new Error('Work 目标角色块内容为空，请先在文档中核对该块');
    const status = attrs['custom-ai-work-status'];
    const knownStatus=status==='active'||status==='paused'||status==='completed'||status==='closed';
    if(status && !knownStatus)throw new Error('Work 状态未知，请核对原文档属性');
    return { id: workId, title: await this.host.getDocumentTitle(workId), goal, status: knownStatus ? status : 'active' };
  }
  async createFromDocument(input: { documentId: string; goal: string; approved: boolean }): Promise<WorkRecord> {
    if (!input.approved) throw new Error('请先确认将当前文档设为 Work');
    if (!isValidDocumentRootId(input.documentId)) throw new Error('需要有效的思源根文档');
    const goal = input.goal.trim().replace(/\s+/g, ' ');
    if (!(await this.host.getDocumentPath(input.documentId))) throw new Error('文档不存在或无法读取');
    const existing = await this.readWork(input.documentId);
    if (existing) {
      if (goal && !existing.goal) throw new Error('这篇文档已是无目标 Work；请在 Work 管理页明确添加目标');
      await this.store.registerWork(input.documentId); return existing;
    }
    const goalBlocks = await this.roleBlocks(input.documentId, 'goal');
    if (goalBlocks.length > 1) throw new Error('检测到多个 Work 目标块，请人工核对');
    if (!goalBlocks.length && goal) {
      await this.host.prependMarkdown(input.documentId, `**目标**：${goal}\n{: custom-ai-work-role="goal"}`);
      if ((await this.roleBlocks(input.documentId, 'goal')).length !== 1) throw new Error('目标块未能读回角色标记；已停止创建，请核对原文档');
    }
    await this.host.setAttrs(input.documentId, { 'custom-ai-work-v0': '1', 'custom-ai-work-status': 'active' });
    const work = await this.readWork(input.documentId);
    if (!work) throw new Error('Work 标记写入后未能读回，请核对文档');
    await this.store.registerWork(input.documentId);
    return work;
  }
  async repairMissingGoal(workId: string, pendingGoal: string, approved: boolean, beforeWrite?: () => Promise<void>): Promise<WorkRecord> {
    if (!approved) throw new Error('请先确认修复这篇 Work 的目标');
    if (!isValidDocumentRootId(workId)) throw new Error('需要有效的思源根文档');
    const goal = pendingGoal.trim().replace(/\s+/g, ' ');
    if (!goal) throw new Error('旧创建记录没有可恢复的工作目标，请人工核对');
    if (!(await this.host.getDocumentPath(workId))) throw new Error('问题文档不存在或暂不可读取');
    const rootAttrs = await this.host.getAttrs(workId);
    if (rootAttrs['custom-ai-work-v0'] !== '1') throw new Error('原文档已没有 Work 标记，请使用核对并继续');
    const marked = await this.roleBlocks(workId, 'goal');
    if (marked.length > 1) throw new WorkGoalError(workId, marked.length);
    if (marked.length === 1) {
      const recovered = (await this.readWork(workId))!;
      if (recovered.goal !== goal) throw new Error('Work 目标已变化，请先核对文档和旧创建记录');
      return recovered;
    }

    // An unmarked target may be an incomplete earlier write. Preserve it for review.
    const children = await this.host.getChildren(workId);
    for (const child of children) {
      const text = normalizeForReadback(await this.host.getBlockMarkdown(child));
      const comparable = text.replace(/\s+/gu, ' ');
      if (comparable.includes(goal) || /(?:^|\n)\s*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?(?:工作目标|目标)(?:\*\*|__)?\s*(?:[：:]|$)/mu.test(text))
        throw new Error('文档可能已有未标记的目标内容，请先人工核对，避免重复写入');
    }
    await beforeWrite?.();
    await this.host.prependMarkdown(workId, `**目标**：${goal}\n{: custom-ai-work-role="goal"}`);
    const after = await this.roleBlocks(workId, 'goal');
    if (after.length !== 1 || (await this.host.getChildren(workId))[0] !== after[0].id) throw new Error('目标块写入后未能确认位于文档顶部，请核对原文档');
    const work = await this.readWork(workId);
    if (!work || work.goal !== goal) throw new Error('目标块写入后读回不一致，请核对原文档');
    return work;
  }
  async setStatus(workId: string, status: WorkStatus, approved: boolean, guard:{expectedStatus?:WorkStatus;isCurrent?:()=>boolean}={}): Promise<void> {
    if (!approved) throw new Error('请先确认修改 Work 状态');
    if(!['active','paused','completed','closed'].includes(status))throw new Error('Work 状态无效');
    if(guard.isCurrent && !guard.isCurrent())throw new Error('页面或操作状态已变化，请重新确认');
    const work=await this.readWork(workId);
    if (!work) throw new Error('Work 不存在');
    if(guard.isCurrent && !guard.isCurrent())throw new Error('页面或操作状态已变化，请重新确认');
    if(guard.expectedStatus && work.status!==guard.expectedStatus)throw new Error('Work 状态已变化，请刷新后重新确认');
    await this.host.setAttrs(workId, { 'custom-ai-work-status': status });
    if ((await this.readWork(workId))?.status !== status) throw new Error('Work 状态未能读回');
  }
  async listExternalDocuments(workId: string): Promise<string[]> {
    if (!(await this.readWork(workId))) return [];
    return (await this.roleBlocks(workId, 'external-ref')).map(x => x.attrs['custom-ai-work-document-id']).filter(isValidDocumentRootId);
  }
  async linkExternalDocument(workId: string, documentId: string, approved: boolean): Promise<void> {
    const next = this.externalLinks.then(() => this.writeExternalDocumentLink(workId,documentId,approved));
    this.externalLinks = next.catch(() => undefined);
    await next;
  }
  private async writeExternalDocumentLink(workId: string, documentId: string, approved: boolean): Promise<void> {
    if (!approved) throw new Error('请先确认关联资料');
    if (!isValidDocumentRootId(documentId)) throw new Error('需要有效文档 ID');
    if (!(await this.readWork(workId))) throw new Error('Work 不存在');
    if (!(await this.host.getDocumentPath(documentId))) throw new Error('关联文档不存在或无法读取');
    if ((await this.listExternalDocuments(workId)).includes(documentId)) return;
    const title = (await this.host.getDocumentTitle(documentId)).replace(/["\n\r]/g, ' ').trim();
    await this.host.appendMarkdown(workId, `**关联资料**：((${documentId} "${title}"))\n{: custom-ai-work-role="external-ref" custom-ai-work-document-id="${documentId}"}`);
    if (!(await this.listExternalDocuments(workId)).includes(documentId)) throw new Error('关联资料未能读回；请核对文档后再试');
  }
}
