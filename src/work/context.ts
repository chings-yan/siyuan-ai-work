export type LoadedContext = { documentId: string; title: string; kind: 'document' | 'block' | 'selection'; text: string; blockId?: string };
export type FrozenRequest = Readonly<{ workId: string | null; chatId: string; connectionId: string; storedSessionId: string | null; chatRootId: string; targetDocumentId: string; documentId: string; context: string }>;

export function buildContextPayload(items: LoadedContext[], maxChars: number): string {
  const text = items.map((item, i) => `【资料 ${i + 1}：${item.title} (${item.documentId})，${item.kind}${item.blockId ? `，块 ${item.blockId}` : ''}】\n${item.text}`).join('\n\n');
  if (text.length > maxChars) throw new Error(`所选资料共 ${text.length} 字符，超过本次可传输上限 ${maxChars}；请缩小范围、改用选区或减少资料。模型实际预算未知。`);
  return text;
}

export function refreshSelection(selected: { selectedText: string; originalBlock: string }, freshBlock: string): string {
  if (freshBlock !== selected.originalBlock || !freshBlock.includes(selected.selectedText)) throw new Error('选区内容已变化，请重新选择后发送');
  return selected.selectedText;
}

export function freezeRequest(input: FrozenRequest): FrozenRequest { return Object.freeze({ ...input }); }
export function assertWriteRoot(chatRootId: string, targetDocumentId: string): void {
  if (chatRootId !== targetDocumentId) throw new Error('当前 Chat 绑定的文档根与写入目标不一致；请为目标文档新建 Chat');
}
