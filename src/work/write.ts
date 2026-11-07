import { normalizeForReadback, validatePlan, type EditPlan } from '../core.ts';
import { assertWriteRoot } from './context.ts';

export type FrozenProposal = { threadId: string; chatRootId: string; targetDocumentId: string; items: EditPlan[] };
export type WritePort = { getRoot(blockId: string): Promise<string | null>; getMarkdown(blockId: string): Promise<string>; beforeWrite?(): Promise<void> | void; updateMarkdown(blockId: string, markdown: string): Promise<void> };
export class WriteFailure extends Error {
  constructor(message: string, readonly written: number, readonly total: number, readonly attempted = written) { super(message); this.name = 'WriteFailure'; }
}
export async function applyApprovedProposal(proposal: FrozenProposal, port: WritePort, approved: boolean): Promise<{ written: number; total: number }> {
  if (!approved) throw new WriteFailure('请先确认接受修改建议', 0, proposal.items.length);
  let written = 0;
  let attempted = 0;
  try {
    assertWriteRoot(proposal.chatRootId, proposal.targetDocumentId);
    const current: Record<string, string> = {};
    for (const item of proposal.items) {
      if (await port.getRoot(item.blockId) !== proposal.targetDocumentId) throw new Error(`块不在原目标文档：${item.blockId}`);
      current[item.blockId] = await port.getMarkdown(item.blockId);
    }
    validatePlan(proposal.items, current);
    for (const item of proposal.items) {
      await port.beforeWrite?.();
      attempted++;
      await port.updateMarkdown(item.blockId, item.replacement);
      written++;
      const readback = await port.getMarkdown(item.blockId);
      if (normalizeForReadback(readback) !== normalizeForReadback(item.replacement)) throw new Error(`写入已发生但读回不匹配：${item.blockId}`);
    }
    return { written, total: proposal.items.length };
  } catch (error) { throw new WriteFailure(error instanceof Error ? error.message : String(error), written, proposal.items.length, attempted); }
}
