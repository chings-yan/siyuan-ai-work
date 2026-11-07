export type WorkTemplateId = 'blank' | 'reading' | 'project' | 'meeting';
export type WorkTemplateSnapshot = { id: Exclude<WorkTemplateId, 'blank'>; version: 1; markdown: string };

// Versioned bodies are persisted with the creation intent. Never replace a version's
// text in place: a pending creation must keep its original preview and verification.
const catalog = [
  { id: 'blank', title: '空白工作文档', markdown: '' },
  { id: 'reading', title: '阅读笔记', markdown: '## 阅读目标\n\n我想通过阅读弄清什么？\n\n## 关键观点\n\n记录观点及原文出处。\n\n## 我的理解\n\n用自己的话解释，并写下疑问。\n\n## 下一步\n\n记录要验证的问题或行动。' },
  { id: 'project', title: '项目计划', markdown: '## 项目背景\n\n记录要解决的问题与范围。\n\n## 里程碑\n\n列出关键阶段及验收条件。\n\n## 风险与依赖\n\n记录待确认的约束与协作事项。\n\n## 下一步\n\n记录准备推进的行动。' },
  { id: 'meeting', title: '会议记录', markdown: '## 会议主题\n\n记录本次讨论的目的。\n\n## 讨论要点\n\n记录观点与需要核对的信息。\n\n## 决定\n\n记录已确认的决定及依据。\n\n## 行动项\n\n记录负责人、行动和约定时间；任务可另行手选关联。' },
] as const;

export function listWorkTemplates(): { id: WorkTemplateId; title: string }[] {
  return catalog.map(({ id, title }) => ({ id, title }));
}

export function workTemplateSnapshot(id: string): WorkTemplateSnapshot | undefined {
  const item = catalog.find(template => template.id === id);
  if (!item) throw new Error('未知的 Work 模板，请重新选择');
  return item.id === 'blank' ? undefined : { id: item.id, version: 1, markdown: item.markdown };
}

export function assertWorkTemplateSnapshot(value: unknown): asserts value is WorkTemplateSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Work 模板记录格式错误，请核对原创建记录');
  const snapshot = value as Record<string, unknown>;
  const item = catalog.find(template => template.id !== 'blank' && template.id === snapshot.id);
  if (!item || snapshot.version !== 1 || snapshot.markdown !== item.markdown ||
      Object.keys(snapshot).some(key => !['id', 'version', 'markdown'].includes(key)))
    throw new Error('Work 模板版本或正文无法核验；保留原记录，不会重新创建');
}
