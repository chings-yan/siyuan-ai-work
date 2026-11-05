import test from 'node:test';
import assert from 'node:assert/strict';
import { applyApprovedProposal, WriteFailure } from '../src/work/write.ts';

const proposal = { threadId: 'chat', chatRootId: 'doc', targetDocumentId: 'doc', items: [{ blockId: 'b1', expectedOriginal: '原文', replacement: '新文' }] };
function fixture(initial = '原文') {
  const blocks = new Map([['b1', initial]]);
  let writes = 0;
  return { blocks, get writes() { return writes; }, port: { getRoot: async (_id: string) => 'doc', getMarkdown: async (id: string) => blocks.get(id) || '', updateMarkdown: async (id: string, text: string) => { writes++; blocks.set(id, text); } } };
}
test('修改建议需明确接受，并阻止跨文档根写入', async () => {
  const f = fixture();
  await assert.rejects(applyApprovedProposal(proposal, f.port, false), /确认/);
  await assert.rejects(applyApprovedProposal({ ...proposal, chatRootId: 'other' }, f.port, true), /新建.*Chat/);
  assert.equal(f.writes, 0);
});
test('写前冲突检查与写后读回', async () => {
  const changed = fixture('用户补写');
  await assert.rejects(applyApprovedProposal(proposal, changed.port, true), /conflict/);
  assert.equal(changed.writes, 0);
  const normal = fixture();
  assert.deepEqual(await applyApprovedProposal(proposal, normal.port, true), { written: 1, total: 1 });
  assert.equal(normal.blocks.get('b1'), '新文');
});
test('读回不匹配明确标记部分写入', async () => {
  const f = fixture();
  const bad = { ...f.port, getMarkdown: async () => '原文' };
  await assert.rejects(applyApprovedProposal(proposal, bad, true), (error: unknown) => error instanceof WriteFailure && error.written === 1);
});
