import { validatePlan, type ContextBlock, type EditPlan } from '../core.ts';

export function parseProposal(content: string, blocks: ContextBlock[]): { text: string; plan: EditPlan[] } | null {
  try {
    const parsed: unknown = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!parsed || typeof parsed !== 'object') return null;
    const value = parsed as Record<string, unknown>;
    if (!Array.isArray(value.plan) || !value.plan.length) return null;
    const baseline = Object.fromEntries(blocks.map(block => [block.blockId, block.sourceMarkdown ?? block.expectedOriginal ?? block.text]));
    const plan = validatePlan(value.plan as EditPlan[], baseline);
    return { text: typeof value.text === 'string' ? value.text : '修改建议待预览', plan };
  } catch { return null; }
}
