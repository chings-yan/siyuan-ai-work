/** Reviewed local drafts only; creating and linking tasks remains with the native task UI. */
export type TaskDraftSource = Readonly<{
  kind: 'answer' | 'selection';
  key: string;
  documentId: string | null;
  documentTitle: string;
}>;
export type TaskDraftInput = { source: TaskDraftSource; body: string; title?: string };
export type TaskDraftItem = { key: string; title: string; description: string };
export type TaskDraftSet = {
  source: TaskDraftSource;
  originalBody: string;
  items: TaskDraftItem[];
  extracted: boolean;
};

export const TASK_DRAFT_TITLE_LIMIT = 200;
export const TASK_DRAFT_CONTENT_LIMIT = 100000;
const TASK_DRAFT_ITEM_LIMIT = 100;
const documentIdPattern = /^\d{14}-[a-z0-9]{7}$/;
export const draftCharacterCount = (text: string): number => [...text].length;

function checkedSource(source: TaskDraftSource): TaskDraftSource {
  if (!source || !['answer', 'selection'].includes(source.kind) || typeof source.key !== 'string'
    || !source.key.trim() || source.key.length > 2000) throw new Error('草稿来源无效，请重新选择来源。');
  if (source.documentId !== null && (typeof source.documentId !== 'string' || !documentIdPattern.test(source.documentId))) {
    throw new Error('来源文档标识无效，请重新选择文档。');
  }
  if (typeof source.documentTitle !== 'string' || source.documentTitle.length > 2000) throw new Error('来源文档名称无效。');
  return Object.freeze({ kind: source.kind, key: source.key, documentId: source.documentId, documentTitle: source.documentTitle });
}

export function taskDraftIssue(item: TaskDraftItem): string | null {
  if (typeof item.title !== 'string' || !item.title.trim()) return '请填写任务标题。';
  if (/[\r\n]/.test(item.title) || draftCharacterCount(item.title) > TASK_DRAFT_TITLE_LIMIT) return `标题应为单行，最多 ${TASK_DRAFT_TITLE_LIMIT} 字。`;
  if (typeof item.description !== 'string' || draftCharacterCount(item.description) > TASK_DRAFT_CONTENT_LIMIT) return `说明过长，最多 ${TASK_DRAFT_CONTENT_LIMIT} 字；请自行编辑后再复制。`;
  return null;
}

export function prepareTaskDrafts(input: TaskDraftInput): TaskDraftSet {
  const source = checkedSource(input.source);
  if (typeof input.body !== 'string' || !input.body.trim()) throw new Error('没有可整理的内容，请选择非空正文。');
  if (draftCharacterCount(input.body) > TASK_DRAFT_CONTENT_LIMIT) throw new Error(`来源内容过长，最多 ${TASK_DRAFT_CONTENT_LIMIT} 字；请明确选择较小的范围。`);
  if (input.title !== undefined && typeof input.title !== 'string') throw new Error('任务标题无效。');
  const items: TaskDraftItem[] = [];
  let fence: { marker: string; size: number } | null = null;
  let firstProse = '';
  for (const line of input.body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.size && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) { fence = { marker: marker[1][0], size: marker[1].length }; continue; }
    if (/^(?: {4}|\t| {0,3}>)/.test(line)) continue;
    const todo = /^ {0,3}[-+*] \[ \][ \t]+(\S.*)$/.exec(line);
    if (todo) {
      items.push({ key: `draft-${items.length + 1}`, title: todo[1].trim(), description: '' });
      if (items.length > TASK_DRAFT_ITEM_LIMIT) throw new Error(`待办超过 ${TASK_DRAFT_ITEM_LIMIT} 项，请明确选择较小的范围。`);
    } else if (!firstProse && line.trim() && !/^ {0,3}[-+*] \[[xX ]\](?:\s|$)/.test(line)) {
      firstProse = line.trim().replace(/^#{1,6}\s+/, '');
    }
  }
  const extracted = items.length > 0;
  if (!extracted) items.push({ key: 'draft-1', title: input.title ?? firstProse, description: input.body });
  return { source, originalBody: input.body, items, extracted };
}

export function serializeTaskDraft(item: TaskDraftItem, source: TaskDraftSource): string {
  const checked = checkedSource(source);
  const issue = taskDraftIssue(item);
  if (issue) throw new Error(issue);
  const sourceText = checked.documentId
    ? `\n\n来源文档：${checked.documentTitle}\nsiyuan://blocks/${checked.documentId}` : '';
  return `标题：${item.title}\n\n说明：\n${item.description}${sourceText}`;
}
