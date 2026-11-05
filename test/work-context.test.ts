import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextPayload, refreshSelection, freezeRequest, assertWriteRoot } from '../src/work/context.ts';

test('资料不静默截断，超出传输上限时发送前拒绝', () => {
  const payload = buildContextPayload([{ documentId: 'd1', title: '文档', kind: 'document', text: '甲'.repeat(18000) }], 30000);
  assert.ok(payload.includes('甲'.repeat(18000)));
  assert.throws(() => buildContextPayload([{ documentId: 'd1', title: '文档', kind: 'document', text: '甲'.repeat(18000) }], 1000), /缩小范围/);
});

test('选区来源改动必须重选，不能扩大为整块', () => {
  const selected = { documentId: 'd1', blockId: 'b1', selectedText: '旧文字', originalBlock: '前旧文字后' };
  assert.equal(refreshSelection(selected, '前旧文字后'), '旧文字');
  assert.throws(() => refreshSelection(selected, '前新文字后'), /重新选择/);
});

test('请求冻结 Work/Chat/目标，写入根仍按 Chat 原绑定检查', () => {
  const request = freezeRequest({ workId: 'w1', chatId: 's1', connectionId:'serve-local', storedSessionId:'stored-1', chatRootId: 'd1', targetDocumentId: 'd2', documentId: 'd2', context: '本次全文' });
  assert.equal(request.targetDocumentId, 'd2');
  assert.throws(() => assertWriteRoot(request.chatRootId, request.targetDocumentId), /新建.*Chat/);
  assert.doesNotThrow(() => assertWriteRoot('d2', 'd2'));
});

test('发送快照冻结固定连接和持久会话 ID', () => {
  const frozen = freezeRequest({ workId:'w', chatId:'c', connectionId:'serve-local', storedSessionId:'stored-1', chatRootId:'20260923123456-abcdefg', targetDocumentId:'20260923123456-abcdefg', documentId:'20260923123456-abcdefg', context:'资料' });
  assert.equal(frozen.connectionId,'serve-local');
  assert.equal(frozen.storedSessionId,'stored-1');
  assert.equal(Object.isFrozen(frozen),true);
});
