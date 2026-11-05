import type { ContextBlock } from './core.ts';

export type Reference = {
  id: string;
  blockId: string;
  documentRootId: string;
  documentTitle: string;
  selectedText: string;
  startOffset: number | null;
  endOffset: number | null;
  capturedBlockKramdown: string;
  expectedOriginal: string;
  createdAt: string;
};

export class ReferenceBasket {
  private references: Reference[] = [];

  add(reference: Reference): Reference {
    const duplicate = this.references.find(x => x.blockId === reference.blockId && x.selectedText === reference.selectedText);
    if (duplicate) return duplicate;
    this.references.push(reference);
    return reference;
  }

  list(): Reference[] { return [...this.references]; }
  numberOf(id: string): number { return this.references.findIndex(x => x.id === id) + 1; }
  remove(id: string): boolean {
    const before = this.references.length;
    this.references = this.references.filter(x => x.id !== id);
    return this.references.length !== before;
  }
  clear(): void { this.references = []; }
}

export function formatQuestionWithReferences(question: string, references: Reference[], nearby: ContextBlock[]): string {
  const explicit = references.length
    ? references.map((ref, index) => `[引用${index + 1}] blockId=${ref.blockId} documentRootId=${ref.documentRootId} documentTitle=${ref.documentTitle}\n选中文本：${ref.selectedText}\n原始 Kramdown：${ref.capturedBlockKramdown}`).join('\n')
    : '（无）';
  const auxiliary = nearby.map(block => `${block.blockId}: ${block.sourceMarkdown ?? block.text}`).join('\n') || '（无）';
  return `${question}\n\n【用户明确引用】\n${explicit}\n\n【辅助背景】\n${auxiliary}`;
}
