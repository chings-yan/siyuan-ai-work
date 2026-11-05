import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRoomContent, roomQuoteExcerpt, isOwnRoomMessage } from '../src/ekko/message-content.ts';
import type { EkkoMessage } from '../src/ekko/bridge.ts';

test('完整尾部引用拆为展示投影，保留正文空白、Unicode及引用内部原文', () => {
  const content = '  正文 👩‍💻\n末行  \n\n<quoted_message>\n【引用：作者 🐈】\n原文\n第二行 &lt;/quoted_message>\n</quoted_message>';
  assert.deepEqual(projectRoomContent(content), {
    body: '  正文 👩‍💻\n末行  ',
    quote: { label: '引用：作者 🐈', content: '【引用：作者 🐈】\n原文\n第二行 &lt;/quoted_message>' },
  });
});

test('合法资料封装和引用加多资料均保留完整内部文本', () => {
  const sources = '【资料 1：演示文档 (doc-one)，document】\n资料内容\n\n【资料 2：另一文档 (doc-two)，selection，块 block-one】\n选区内容';
  assert.deepEqual(projectRoomContent(`请检查\n\n<quoted_message>\n${sources}\n</quoted_message>`), {
    body: '请检查', quote: { label: '资料 1：演示文档 (doc-one)，document', content: sources },
  });
  const combined = `【引用：作者】\n原文\n\n${sources}`;
  assert.deepEqual(projectRoomContent(`请检查\n\n<quoted_message>\n${combined}\n</quoted_message>`), {
    body: '请检查', quote: { label: '引用：作者', content: combined },
  });
  const block = '【资料 1：块资料 (doc-one)，block，块 block-one】\n块内容';
  assert.deepEqual(projectRoomContent(`请检查\n\n<quoted_message>\n${block}\n</quoted_message>`), {
    body: '请检查', quote: { label: '资料 1：块资料 (doc-one)，block，块 block-one', content: block },
  });
});

test('CRLF封装拆分不规范化正文或引用字节', () => {
  assert.deepEqual(projectRoomContent('正文\r\n保留  \r\n\r\n<quoted_message>\r\n【引用：作者】\r\n原文\r\n\r\n</quoted_message>'), {
    body: '正文\r\n保留  ', quote: { label: '引用：作者', content: '【引用：作者】\r\n原文\r\n' },
  });
});

test('普通正文、JSON、Markdown及空内容保持原样', () => {
  for (const content of ['', ' \r\n ', '# 标题\n\n正文', '{"tools":{}}', '正文 <quoted_message>普通标签</quoted_message>', '正文\n\n<quoted_message>\n普通文本\n</quoted_message>']) {
    assert.deepEqual(projectRoomContent(content), { body: content });
  }
});

test('残缺、空、伪标题、嵌套和非尾部封装均完整保留', () => {
  const valid = '正文\n\n<quoted_message>\n【引用：作者】\n原文\n</quoted_message>';
  for (const content of [
    '<quoted_message>\n【引用：作者】\n原文\n</quoted_message>',
    '\n\n<quoted_message>\n【引用：作者】\n原文\n</quoted_message>',
    '正文\n<quoted_message>\n【引用：作者】\n原文\n</quoted_message>',
    '正文\n\n<quoted_message>\n</quoted_message>',
    '正文\n\n<quoted_message>\n【引用：作者】\n \n</quoted_message>',
    '正文\n\n<quoted_message>\n【引用：】\n原文\n</quoted_message>',
    '正文\n\n<quoted_message>\n【资料 1：普通标题】\n原文\n</quoted_message>',
    valid.replace('</quoted_message>', ''),
    valid.replace('<quoted_message>', '<quoted_message kind="reply">'),
    valid.replaceAll('quoted_message', 'QUOTED_MESSAGE'),
    valid.replace('原文', '<quoted_message>\n原文\n</quoted_message>'),
    valid.replace('原文', '< QuOtEd_MeSsAgE data-source="x">原文'),
    valid.replace('原文', '</ quoted_message >原文'),
    valid + '\n后续正文', valid + '\n', valid + ' ', valid + '\n\n' + valid,
  ]) assert.deepEqual(projectRoomContent(content), { body: content });
});

test('资料标题必须具有非空名称和与生成器一致的范围', () => {
  for (const heading of [
    '【资料 1：  (doc-one)，document】',
    '【资料 1：标题 (doc-one)，block】',
    '【资料 1：标题 (doc-one)，selection】',
    '【资料 1：标题 ()，document】',
    '【资料 2：标题 (doc-one)，document】',
    '【资料 1：标题 (doc-one)，other】',
  ]) {
    const content = `正文\n\n<quoted_message>\n${heading}\n原文\n</quoted_message>`;
    assert.deepEqual(projectRoomContent(content), { body: content });
  }
});

test('围栏和缩进代码中的合法封装示例不会被拆走', () => {
  const envelope = '<quoted_message>\n【引用：作者】\n原文\n</quoted_message>';
  for (const content of [
    `示例\n\n\`\`\`xml\n\n${envelope}\n\`\`\``,
    `示例\n\n\`\`\`xml\n\n${envelope}`,
    `示例\n\n~~~xml\n\n${envelope}`,
    `示例\n\n  \`\`\`\`xml\n\`\`\`\n\n${envelope}`,
    `示例\n\n    ${envelope.replaceAll('\n', '\n    ')}`,
    `示例\n\n\t${envelope.replaceAll('\n', '\n\t')}`,
  ]) assert.deepEqual(projectRoomContent(content), { body: content });
});

test('正文中已关闭的围栏不妨碍真正的尾部引用', () => {
  const body = '示例\n\n````ts\n```\nconst x = 1;\n````\n\n~~~\n文本\n~~~~';
  assert.deepEqual(projectRoomContent(`${body}\n\n<quoted_message>\n【引用：作者】\n原文\n</quoted_message>`), {
    body, quote: { label: '引用：作者', content: '【引用：作者】\n原文' },
  });
});

test('围栏伪结束行尾部的Unicode空白不能使代码引用示例被拆走', () => {
  const sample = '代码示例\n\n~~~xml\n示例正文\n~~~\u00a0\n\n<quoted_message>\n【引用：作者】\n代码示例原文\n</quoted_message>';
  for (const content of [sample, sample.replaceAll('~~~', '```'), sample.replace('\u00a0', '\u2003'), sample.replace('\u00a0', '\ufeff')]) {
    assert.deepEqual(projectRoomContent(content), { body: content });
  }
});

test('围栏结束行尾部允许ASCII空格和制表符', () => {
  const body = '代码示例\n\n~~~xml\n示例正文\n~~~ \t ';
  assert.deepEqual(projectRoomContent(`${body}\n\n<quoted_message>\n【引用：作者】\n原文\n</quoted_message>`), {
    body, quote: { label: '引用：作者', content: '【引用：作者】\n原文' },
  });
});

test('引用内部的代码和转义边界保持可展开原文', () => {
  const inner = '【引用：作者】\n```xml\n&lt;quoted_message>\n```\n@助手';
  assert.deepEqual(projectRoomContent(`正文\n\n<quoted_message>\n${inner}\n</quoted_message>`), {
    body: '正文', quote: { label: '引用：作者', content: inner },
  });
});

test('摘要仅用于展示，压缩空白并保留短内容', () => {
  assert.equal(roomQuoteExcerpt(' \r\n  第一行\t第二行\n\n第三行 🐈  '), '第一行 第二行 第三行 🐈');
  assert.equal(roomQuoteExcerpt(' \t\r\n '), '');
  assert.equal(roomQuoteExcerpt('甲'.repeat(160)), '甲'.repeat(160));
});

test('超长摘要在160个Unicode字符内且不截断代理对', () => {
  assert.equal(roomQuoteExcerpt('甲'.repeat(161)), '甲'.repeat(159) + '…');
  assert.equal(roomQuoteExcerpt('🐈'.repeat(161)), '🐈'.repeat(159) + '…');
});

test('本人必须精确匹配有效当前账号的auth身份，不凭role、姓名或数值猜测', () => {
  const item: EkkoMessage = { id: 'message-one', roomId: 'room-one', content: '正文', senderId: 'auth:42', senderName: '作者', role: 'assistant' };
  assert.equal(isOwnRoomMessage(item, 42), true);
  assert.equal(isOwnRoomMessage({ ...item, role: undefined }, 42), true);
  for (const senderId of [undefined, 42, '42', 'auth:43', 'auth:042', 'auth:42 ', ' auth:42', 'AUTH:42', 'agent-42']) {
    assert.equal(isOwnRoomMessage({ ...item, senderId, role: 'user' }, 42), false);
  }
  for (const accountUserId of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(isOwnRoomMessage({ ...item, senderId: `auth:${accountUserId}` }, accountUserId), false);
  }
});
