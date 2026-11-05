import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProposal } from '../src/work/proposal.ts';

const blocks = [{ blockId: 'b1', text: '旧', sourceMarkdown: '原始内容', expectedOriginal: '原始内容' }];
test('只接收有本轮块基线的结构化建议', () => {
  const parsed = parseProposal('{"text":"建议调整","plan":[{"blockId":"b1","expectedOriginal":"原始内容","replacement":"新内容"}]}', blocks);
  assert.equal(parsed?.text, '建议调整');
  assert.equal(parsed?.plan[0].blockId, 'b1');
  assert.equal(parseProposal('{"text":"x","plan":[{"blockId":"b2","expectedOriginal":"x","replacement":"y"}]}', blocks), null);
  assert.equal(parseProposal('普通讨论回复', blocks), null);
});
