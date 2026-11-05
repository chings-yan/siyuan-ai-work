export type ContextBlock = { blockId: string; text: string; sourceMarkdown?: string; expectedOriginal?: string };
export type ContextInput = { documentId:string; title:string; focusBlockId:string; selection:string; nearby:ContextBlock[]; recent:ContextBlock[] };
export type Snapshot = ContextInput & { contextText:string; createdAt:string; degraded:boolean };
export type EditPlan = { blockId:string; expectedOriginal:string; replacement:string };

const SIYUAN_DOCUMENT_ROOT_ID = /^\d{14}-[a-z0-9]{7}$/;

export function isValidDocumentRootId(documentRootId:unknown): documentRootId is string {
  return typeof documentRootId === 'string' && SIYUAN_DOCUMENT_ROOT_ID.test(documentRootId);
}

export function isBindableDocumentRoot(documentRootId:unknown): documentRootId is string {
  return isValidDocumentRootId(documentRootId);
}

export function assertSnapshotMatchesThread(threadDocumentRootId:string, snapshot:Pick<Snapshot,'documentId'>): void {
  if (threadDocumentRootId !== snapshot.documentId) throw new Error('文档快照与当前对话不一致，已阻止发送');
}

export function parseKramdownResponse(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length ? parseKramdownResponse(value[0]) : '';
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['kramdown', 'markdown', 'content']) if (key in record) return parseKramdownResponse(record[key]);
  }
  return '';
}

export function normalizeForReadback(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').replace(/\n\s*\{:\s*[^\n}]*\}\s*$/u, '').trim();
}

export function buildSnapshot(input: ContextInput, opts:{maxChars:number}): Snapshot {
  const maxChars = Math.max(1, Math.floor(opts.maxChars));
  const format = (blocks: ContextBlock[]) => blocks.map(block => `${block.blockId}: ${block.sourceMarkdown ?? block.text}`).join('\n');
  const sections = [`文档: ${input.title} (${input.documentId})`, `焦点块: ${input.focusBlockId}`, `选区: ${input.selection}`, `附近块:\n${format(input.nearby)}`, `最近变化块:\n${format(input.recent)}`];
  return { ...input, contextText: sections.join('\n').slice(0, maxChars), createdAt: new Date().toISOString(), degraded: input.recent.length === 0 };
}

export function validatePlan(plan: EditPlan[], current: Record<string,string>): EditPlan[] {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error('empty plan');
  const seen = new Set<string>();
  for (const item of plan) {
    if (!item || typeof item.blockId !== 'string' || seen.has(item.blockId)) throw new Error(`invalid or duplicate blockId: ${item?.blockId}`);
    seen.add(item.blockId);
    if (!(item.blockId in current)) throw new Error(`missing block: ${item.blockId}`);
    if (normalizeForReadback(current[item.blockId]) !== normalizeForReadback(item.expectedOriginal)) throw new Error(`conflict on block ${item.blockId}`);
    if (typeof item.replacement !== 'string' || !item.replacement.trim()) throw new Error(`empty replacement: ${item.blockId}`);
  }
  return plan;
}
export function applyPlan(plan: EditPlan[], blocks: Record<string,string>, opts:{accepted:boolean}): Record<string,string> {
  if (!opts.accepted) throw new Error('explicitly accepted is required');
  validatePlan(plan, blocks); const next = { ...blocks }; for (const item of plan) next[item.blockId] = item.replacement; return next;
}
