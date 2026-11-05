import test from 'node:test';
import assert from 'node:assert/strict';
import { roomMessageView } from '../src/ekko/presentation.ts';
import type { EkkoMessage } from '../src/ekko/bridge.ts';

const agents = [{ agentId: 'fictional-agent' }];
const search = {
  total_available: 3,
  results: [{ query: 'fictional document outline', matches: ['fictional_outline'] }],
  tools: { fictional_outline: { source: 'mcp', source_name: 'fictional-docs', description: 'Read an outline', required: ['id'] } },
};
const outline = 'Document outline (2 headings):\n\n- [标题一] (id: 20990101000000-aaaaaaa, depth: 0)\n  - [标题二] (id: 20990101000001-bbbbbbb, depth: 1)';
const suppliedSearch = { total_available: 4, results: [{ query: 'example_tool search', matches: [], available_sources: [
  { name: 'example-reading-readonly', tool_count: 3 }, { name: 'example-reading-write', tool_count: 1 },
], hint: 'Synthetic tool search diagnostic.' }], tools: {} };
const suppliedOutline = { result: 'Document outline (2 headings):\n\n- [1. Fictional chapter] (id: 20990101000000-aaaaaaa, depth: 0)\n - [1.1 Fictional section] (id: 20990101000001-bbbbbbb, depth: 1)\n... (truncated)' };
const bot = (content: string, extra: Partial<EkkoMessage> = {}): EkkoMessage => ({
  id: 'fictional-message', roomId: 'fictional-room', senderId: 'fictional-agent', role: 'assistant', content,
  timestamp: '2026-10-26T00:00:00Z', mentions: [], ...extra,
});
const view = (value: unknown) => roomMessageView(bot(JSON.stringify(value)), agents)?.presentation;

test('standalone tool search and outline results preserve every raw field in a result projection', () => {
  for (const content of [JSON.stringify(search), JSON.stringify({ result: outline }), JSON.stringify(suppliedSearch), JSON.stringify(suppliedOutline)]) {
    const item = bot(' \r\n' + content + '\n', { isStreaming: false });
    assert.deepEqual(roomMessageView(item, agents), { ...item, presentation: 'result' });
    assert.equal(item.content, ' \r\n' + content + '\n');
  }
  assert.equal(view({ tools: { x: { description: 'schema', parameters: { type: 'object', properties: {} } } } }), 'tools');
  assert.equal(view({ runId: 'r', assistantMessageId: 'm', inputTokens: 0, outputTokens: 1 }), 'stats');
});

test('tool search accepts matching query batches, repeated hits and typed empty fallback results', () => {
  const fallback = { query: 'no fictional match', matches: [], available_sources: [
    { name: 'fictional-docs', tool_count: 3 }, { name: 'fictional-offline', tool_count: 0, unavailable: 'not connected' },
  ], hint: 'Try a source name' };
  for (const value of [
    { ...search, queries: ['fictional document outline'] },
    { ...search, total_available: 1, results: [...search.results, ...search.results], queries: ['fictional document outline', 'fictional document outline'] },
    { total_available: 0, results: [{ query: 'nothing', matches: [] }], tools: {} },
    { total_available: 3, results: [fallback], tools: {} },
    { total_available: 0, results: [{ query: 'nothing', matches: [], available_sources: [], hint: '' }], tools: {} },
    { ...search, results: [...search.results, fallback] },
  ]) assert.equal(view(value), 'result', JSON.stringify(value));
});

test('tool search rejects incomplete, extra, mistyped or internally inconsistent envelopes', () => {
  const missing = (object: object, key: string) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
  const withResult = (result: unknown) => ({ ...search, results: [result] });
  const withTool = (tool: unknown) => ({ ...search, tools: { fictional_outline: tool } });
  const tool = search.tools.fictional_outline;
  const fallback = { query: 'nothing', matches: [] };
  const withSource = (source: unknown) => ({ total_available: 0, results: [{ ...fallback, available_sources: [source] }], tools: {} });
  const cases: unknown[] = [
    {}, [], [search], null, { tools: {} }, { result: 'ordinary answer' }, { ...search, answer: 'normal reply' },
    { ...search, connectors: {} },
    ...['total_available', 'results', 'tools'].map(key => missing(search, key)),
    ...[-1, 0.5, '3', null, false, Number.MAX_SAFE_INTEGER + 1].map(total_available => ({ ...search, total_available })),
    { ...search, total_available: 0 },
    ...[[], {}, null, 'matches'].map(results => ({ ...search, results })),
    ...[[], null, 'tools'].map(tools => ({ ...search, tools })),
    ...['query', 'matches'].map(key => withResult(missing(search.results[0], key))),
    ...['', '  ', 1, null].map(query => withResult({ query, matches: ['fictional_outline'] })),
    ...[null, {}, 'fictional_outline', [1], [null]].map(matches => withResult({ query: 'q', matches })),
    withResult({ query: 'q', matches: ['other'] }), withResult({ query: 'q', matches: [] }),
    withResult({ ...search.results[0], available_sources: [] }), withResult({ ...search.results[0], hint: '' }),
    withResult({ ...search.results[0], answer: 'keep' }),
    { ...search, tools: { ...search.tools, extra: tool } },
    ...[[], {}, 'wrong', ['different'], ['fictional document outline', 'extra'], [1]].map(queries => ({ ...search, queries })),
    ...['source', 'source_name', 'description', 'required'].flatMap(key => [withTool(missing(tool, key)), withTool({ ...tool, [key]: null })]),
    ...['source', 'source_name', 'description'].map(key => withTool({ ...tool, [key]: [] })),
    ...['id', [1], {}, false].map(required => withTool({ ...tool, required })),
    withTool({ ...tool, answer: 'keep' }), withTool([]),
    withSource({ tool_count: 0 }), withSource({ name: 'x' }), withSource({ name: 1, tool_count: 0 }),
    ...[-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1].map(tool_count => withSource({ name: 'x', tool_count })),
    withSource({ name: 'x', tool_count: 0, unavailable: false }), withSource({ name: 'x', tool_count: 0, extra: 'keep' }),
    ...[{}, 'x', null].map(available_sources => ({ total_available: 0, results: [{ ...fallback, available_sources }], tools: {} })),
    { total_available: 0, results: [{ ...fallback, hint: 3 }], tools: {} },
  ];
  for (const value of cases) assert.equal(view(value), 'reply', JSON.stringify(value));
});

test('outline accepts full LF or CRLF headings, indentation and a bounded truncation marker', () => {
  for (const result of [outline, outline.replaceAll('\n', '\r\n'), outline + '\n',
    'Document outline (1 headings):\n\n\t- [标题] (id: 20990101000000-aaaaaaa, depth: 0)',
    'Document outline (3 headings):\n\n- [标题] (id: 20990101000000-aaaaaaa, depth: 9)\n... (truncated)',
    outline + '\n... (truncated)',
  ]) assert.equal(view({ result }), 'result', result);
});

test('outline rejects prose, fences, invalid lines and inconsistent heading counts', () => {
  for (const result of [
    '', 'ordinary result', 'Document outline (0 headings):\n\n',
    outline.replace('(2 headings)', '(1 headings)'), outline.replace('(2 headings)', '(3 headings)'),
    outline.replace('(2 headings)', '(-2 headings)'), outline.replace('(2 headings)', '(2.0 headings)'),
    outline.replace('(2 headings)', '(9007199254740992 headings)'),
    outline.replace('\n\n', '\n'), outline.replace('depth: 0', 'depth: -1'), outline.replace('depth: 0', 'depth: 1.5'),
    outline.replace('depth: 0', 'depth: 9007199254740992'), outline.replace('id: 20990101000000-aaaaaaa', 'id: '),
    outline.replace('id: 20990101000000-aaaaaaa', 'id:   '), outline.replace('- [标题一]', '* [标题一]'),
    outline.replace('- [标题一]', '- 标题一'), outline.replace('depth: 0)', 'depth: 0) extra'),
    outline + '\nExplanation', 'Explanation\n' + outline, '```\n' + outline + '\n```',
    outline.replace('- [标题一]', '- [`标题一`]') + '\n```',
    'Document outline (1 headings):\n\n... (truncated)', outline.replace('(2 headings)', '(1 headings)') + '\n... (truncated)',
    outline + '\n... (truncated)\nextra', outline + '\n... (truncated)\n... (truncated)',
  ]) assert.equal(view({ result }), 'reply', result);
  for (const value of [{ result: outline, answer: 'keep' }, { result: outline, tools: {} }, { result: 1 }, { result: [outline] }]) {
    assert.equal(view(value), 'reply', JSON.stringify(value));
  }
});

for (const id of ['fictional-root', 'fictional-section', '2099010100000-aaaaaaa', '20990101000000-aaaaaa',
  '20990101000000-AAAAAAA', '20990101000000-aaaaaa_', '20990101000000 aaaaaaa',
  ' 20990101000000-aaaaaaa', '20990101000000-aaaaaaa ', '20990101000000-aaa aaa',
  '(20990101000000-aaaaaaa)', '20990101000000-aaaaaaa)', '20990101000000-aaaaaaa extra',
]) test(`outline rejects schematic or decorated SiYuan ID: ${JSON.stringify(id)}`, () => {
  assert.equal(view({ result: outline.replace('20990101000000-aaaaaaa', id) }), 'reply', id);
});

test('results require existing bot evidence with human precedence and never match JSON fragments', () => {
  for (const content of [JSON.stringify(search), JSON.stringify({ result: outline })]) {
    for (const extra of [{ role: 'user' }, { senderId: 'auth:7' }, { role: undefined, senderId: undefined, senderName: 'fictional-agent' },
      { role: undefined, senderId: 'unverified', senderName: 'fictional-agent' }]) {
      assert.equal(roomMessageView(bot(content, extra), agents)?.presentation, 'reply');
    }
    assert.equal(roomMessageView(bot(content, { role: undefined }), agents)?.presentation, 'result');
    for (const fragment of ['```json\n' + content + '\n```', 'Explanation ' + content, content + '\nExplanation', content.slice(0, -1)]) {
      assert.equal(roomMessageView(bot(fragment), agents)?.presentation, 'reply', fragment);
    }
  }
  assert.equal(roomMessageView(bot('{"result":', { isStreaming: true }), agents)?.presentation, 'waiting');
  assert.equal(roomMessageView(bot(' \r\n'), agents), null);
});

// Explicit tool provenance requires both the verified agent identity and a boolean completion state.
const explicitToolContents = [
  ['canonical search', JSON.stringify(suppliedSearch)], ['canonical outline', JSON.stringify(suppliedOutline)],
  ['SQL text', ' \r\nfictional_id | count\r\nrow-one | 2\r\n'],
  ['arbitrary result', '{"result":"fictional arbitrary result","answer":"extra fields allowed for explicit tools"}'],
  ['JSON scalar', '42'], ['JSON string', '"fictional scalar"'], ['JSON array', '["fictional",2]'],
  ['code', '```sql\nSELECT 1 AS fictional_count;\n```'],
  ['HTML', '<img src=x onerror=alert(1)><script>fictional unsafe text</script>'],
  ['schema definition', '{"tools":{"x":{"description":"schema","parameters":{"type":"object","properties":{}}}}}'],
  ['run statistics', '{"runId":"r","assistantMessageId":"m","inputTokens":0,"outputTokens":1}'],
] as const;
for (const [kind, content] of explicitToolContents) test(`explicit tool completed ${kind} uses result projection with exact fields`, () => {
  const item = bot(content, { role: 'tool', isStreaming: false });
  assert.deepEqual(roomMessageView(item, agents), { ...item, presentation: 'result' });
});
for (const [kind, content] of explicitToolContents) test(`explicit tool streaming ${kind} hides all partial content behind waiting`, () => {
  const item = bot(content, { role: 'tool', isStreaming: true });
  assert.deepEqual(roomMessageView(item, agents), { ...item, presentation: 'waiting' });
});

test('explicit tool requires exact verified sender and gives human sources precedence', () => {
  for (const content of [explicitToolContents[2][1], JSON.stringify(suppliedOutline)]) {
    for (const extra of [{ senderId: undefined }, { senderId: 'unverified' }, { senderId: 'fictional-agent ' },
      { senderId: 7 }, { senderId: 'auth:7' }, { role: 'user' }]) {
      assert.equal(roomMessageView(bot(content, { role: 'tool', isStreaming: false, ...extra }), agents)?.presentation, 'reply');
    }
    assert.equal(roomMessageView(bot(content, { role: 'tool', isStreaming: false }), [])?.presentation, 'reply');
    assert.equal(roomMessageView(bot(content, { role: 'tool', isStreaming: false, senderId: 'auth:7' }), [{ agentId: 'auth:7' }])?.presentation, 'reply');
  }
});

test('explicit tool missing or malformed streaming flag retains strict structural fallback', () => {
  for (const isStreaming of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) {
    for (const content of ['plain fictional SQL result', '{"result":"arbitrary"}', '42', '```\nfictional code\n```']) {
      assert.equal(roomMessageView(bot(content, { role: 'tool', isStreaming: isStreaming as boolean }), agents)?.presentation, 'reply');
    }
    assert.equal(roomMessageView(bot(JSON.stringify(suppliedOutline), { role: 'tool', isStreaming: isStreaming as boolean }), agents)?.presentation, 'result');
    assert.equal(roomMessageView(bot('{"tools":{"x":{"description":"schema","parameters":{"type":"object","properties":{}}}}}',
      { role: 'tool', isStreaming: isStreaming as boolean }), agents)?.presentation, 'tools');
  }
});

test('explicit tool blank completion stays absent and blank streaming remains waiting', () => {
  assert.equal(roomMessageView(bot(' \r\n\t', { role: 'tool', isStreaming: false }), agents), null);
  assert.equal(roomMessageView(bot(' \r\n\t', { role: 'tool', isStreaming: true }), agents)?.presentation, 'waiting');
});

test('ordinary assistant content keeps conservative presentation without explicit tool role', () => {
  for (const content of ['SQL result', '{"result":"normal answer"}', '42', '```json\n{"result":"normal"}\n```',
    'Explanation: ' + JSON.stringify(suppliedOutline), JSON.stringify(suppliedOutline) + '\nexplanation']) {
    assert.equal(roomMessageView(bot(content, { isStreaming: false }), agents)?.presentation, 'reply');
  }
});

// Missing flag on the full-message channel is distinct from a present invalid value.
for (const [kind, content] of explicitToolContents) test(`omitted full-message tool ${kind} completes without inventing a streaming field`, () => {
  const item = bot(content, { preservesStreamingFlagPresence: true, role: 'tool' });
  assert.equal(Object.hasOwn(item, 'isStreaming'), false);
  const projected = roomMessageView(item, agents);
  assert.deepEqual(projected, { ...item, presentation: 'result' });
  assert.equal(Object.hasOwn(projected!, 'isStreaming'), false);
  assert.equal(Object.hasOwn(item, 'isStreaming'), false);
});

test('omitted full-message tool keeps empty records absent and refuses unknown or human identities', () => {
  assert.equal(roomMessageView(bot(' \r\n', { preservesStreamingFlagPresence: true, role: 'tool' }), agents), null);
  for (const extra of [{ senderId: undefined }, { senderId: 'foreign' }, { senderId: 'fictional-agent ' },
    { senderId: 7 }, { senderId: 'auth:7' }, { role: 'user' }]) {
    assert.equal(roomMessageView(bot('plain fictional tool output', { preservesStreamingFlagPresence: true, role: 'tool', ...extra }), agents)?.presentation, 'reply');
  }
  assert.equal(roomMessageView(bot('plain fictional tool output', { preservesStreamingFlagPresence: true, role: 'tool' }), [])?.presentation, 'reply');
  for (const isStreaming of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) {
    assert.equal(roomMessageView(bot('plain fictional tool output', { preservesStreamingFlagPresence: true, role: 'tool', isStreaming: isStreaming as boolean }), agents)?.presentation, 'reply');
  }
});

const legacyCapabilityCases = [
  { name: 'absent', extra: {} }, { name: 'false', extra: { preservesStreamingFlagPresence: false } },
  { name: 'undefined', extra: { preservesStreamingFlagPresence: undefined } },
  { name: 'null', extra: { preservesStreamingFlagPresence: null } },
  { name: 'number', extra: { preservesStreamingFlagPresence: 1 } },
  { name: 'string', extra: { preservesStreamingFlagPresence: 'true' } },
  { name: 'object', extra: { preservesStreamingFlagPresence: {} } },
] as const;
for (const scenario of legacyCapabilityCases) test(`capability boundary missing flag with ${scenario.name} capability stays conservatively readable`, () => {
  const item = { ...bot('fictional generic SQL rows', { role: 'tool' }), ...scenario.extra };
  assert.equal(roomMessageView(item as unknown as EkkoMessage, agents)?.presentation, 'reply');
});
test('capability boundary accepts only an own true Bridge marker and never grants sender identity', () => {
  const item = { ...bot('fictional generic SQL rows', { role: 'tool' }), preservesStreamingFlagPresence: true };
  assert.deepEqual(roomMessageView(item, agents), { ...item, presentation: 'result' });
  const inherited = Object.assign(Object.create({ preservesStreamingFlagPresence: true }), bot(item.content, { role: 'tool' }));
  assert.equal(roomMessageView(inherited, agents)?.presentation, 'reply');
  for (const extra of [{ senderId: undefined }, { senderId: 'unknown' }, { senderId: 'auth:7' }, { role: 'user' }]) {
    assert.equal(roomMessageView({ ...item, ...extra }, agents)?.presentation, 'reply');
  }
  for (const isStreaming of [undefined, null, 0, 'false', {}, []]) {
    assert.equal(roomMessageView({ ...item, isStreaming } as unknown as EkkoMessage, agents)?.presentation, 'reply');
  }
  assert.equal(roomMessageView({ ...item, isStreaming: false }, agents)?.presentation, 'result');
  assert.equal(roomMessageView({ ...item, isStreaming: true }, agents)?.presentation, 'waiting');
  assert.equal(roomMessageView(bot(JSON.stringify(suppliedOutline), { role: 'tool' }), agents)?.presentation, 'result');
});
