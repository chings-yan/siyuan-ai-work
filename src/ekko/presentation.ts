import type { EkkoMessage } from './bridge.ts';
import { isValidDocumentRootId } from '../core.ts';

export type RoomMessageView = EkkoMessage & { presentation: 'reply' | 'waiting' | 'tools' | 'stats' | 'result' };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const identifier = (value: unknown) => typeof value === 'string' && !!value.trim();
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const fields = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

function toolSearchResult(value: Record<string, unknown>): boolean {
  if (!fields(value, ['total_available', 'results', 'tools'], ['queries']) || !count(value.total_available) ||
    !Array.isArray(value.results) || !value.results.length || !record(value.tools)) return false;
  const results = value.results;
  const hits = new Set<string>();
  for (const result of results) {
    if (!record(result) || !fields(result, ['query', 'matches'], ['available_sources', 'hint']) ||
      !identifier(result.query) || !strings(result.matches)) return false;
    if (result.matches.length && (Object.hasOwn(result, 'available_sources') || Object.hasOwn(result, 'hint'))) return false;
    if (Object.hasOwn(result, 'hint') && typeof result.hint !== 'string') return false;
    if (Object.hasOwn(result, 'available_sources') && (!Array.isArray(result.available_sources) ||
      !result.available_sources.every(source => record(source) && fields(source, ['name', 'tool_count'], ['unavailable']) &&
        typeof source.name === 'string' && count(source.tool_count) &&
        (!Object.hasOwn(source, 'unavailable') || typeof source.unavailable === 'string')))) return false;
    result.matches.forEach(name => hits.add(name));
  }
  if (Object.hasOwn(value, 'queries') && (!strings(value.queries) || value.queries.length !== results.length ||
    value.queries.some((query, index) => query !== results[index].query))) return false;
  const names = Object.keys(value.tools);
  return Number(value.total_available) >= hits.size && names.length === hits.size && names.every(name => hits.has(name)) &&
    Object.values(value.tools).every(tool => record(tool) && fields(tool, ['source', 'source_name', 'description', 'required']) &&
      typeof tool.source === 'string' && typeof tool.source_name === 'string' && typeof tool.description === 'string' && strings(tool.required));
}

function documentOutlineResult(value: Record<string, unknown>): boolean {
  if (!fields(value, ['result']) || typeof value.result !== 'string') return false;
  const lines = value.result.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header = /^Document outline \(([0-9]+) headings\):$/.exec(lines.shift() ?? '');
  if (!header || !count(Number(header[1])) || lines.shift() !== '') return false;
  const truncated = lines.at(-1) === '... (truncated)';
  if (truncated) lines.pop();
  if (!lines.length || (truncated ? lines.length > Number(header[1]) : lines.length !== Number(header[1]))) return false;
  return lines.every(line => {
    const heading = /^[ \t]*- \[([^\r\n]+)\] \(id: ([^,\r\n]+), depth: ([0-9]+)\)$/.exec(line);
    return !!heading && identifier(heading[1]) && isValidDocumentRootId(heading[2]) && count(Number(heading[3]));
  });
}

function toolRegistry(value: Record<string, unknown>): boolean {
  if (Object.keys(value).length !== 1 || !record(value.tools) || !Object.keys(value.tools).length) return false;
  return Object.values(value.tools).every(tool => record(tool) && typeof tool.description === 'string' &&
    record(tool.parameters) && tool.parameters.type === 'object' && record(tool.parameters.properties));
}
function runStatistics(value: Record<string, unknown>): boolean {
  const required = ['runId', 'assistantMessageId', 'inputTokens', 'outputTokens'];
  const optional = ['part', 'cacheReadTokens', 'cacheHitRate', 'costUsd', 'tokensPerSecond', 'speedSource', 'isEstimated'];
  if (!required.every(key => Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) return false;
  if (!identifier(value.runId) || !identifier(value.assistantMessageId) || !['inputTokens', 'outputTokens'].every(key => count(value[key]))) return false;
  return optional.every(key => !Object.hasOwn(value, key) || (key === 'speedSource' ? identifier(value[key]) :
    key === 'isEstimated' ? typeof value[key] === 'boolean' : key === 'part' || key === 'cacheReadTokens' ? count(value[key]) : nonnegative(value[key])));
}

/** Projects full history/room.message records, never raw stream fragments; raw fields stay intact. */
export function roomMessageView(item: EkkoMessage, agents: ReadonlyArray<{ agentId: string }>): RoomMessageView | null {
  const content = item.content.trim();
  const human = item.role === 'user' || typeof item.senderId === 'string' && item.senderId.startsWith('auth:');
  const verifiedAgent = typeof item.senderId === 'string' && agents.some(agent => agent.agentId === item.senderId);
  const bot = !human && (item.role === 'assistant' || verifiedAgent);
  // Only a capable paired Bridge can distinguish a genuinely omitted flag from a filtered invalid one.
  const streamingFlagPresent = Object.hasOwn(item, 'isStreaming');
  const preservesFlagPresence = Object.hasOwn(item, 'preservesStreamingFlagPresence') && item.preservesStreamingFlagPresence === true;
  if (!human && verifiedAgent && item.role === 'tool' && (streamingFlagPresent ? typeof item.isStreaming === 'boolean' : preservesFlagPresence)) {
    if (streamingFlagPresent && item.isStreaming === true) return { ...item, presentation: 'waiting' };
    return content ? { ...item, presentation: 'result' } : null;
  }
  if (!content) return item.isStreaming && bot ? { ...item, presentation: 'waiting' } : null;
  if (!bot || !/^[{[]/.test(content)) return { ...item, presentation: 'reply' };
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch { return { ...item, presentation: item.isStreaming ? 'waiting' : 'reply' }; }
  // A narrow, reversible display heuristic; content shape is not trusted tool provenance.
  return { ...item, presentation: record(parsed) && toolRegistry(parsed) ? 'tools' : record(parsed) && runStatistics(parsed) ? 'stats' :
    record(parsed) && (toolSearchResult(parsed) || documentOutlineResult(parsed)) ? 'result' : 'reply' };
}
