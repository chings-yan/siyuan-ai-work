import { BridgeError, isValidByteStringHeaderValue, type BridgeConfig } from '../bridge.ts';
import { isValidDocumentRootId } from '../core.ts';
import type { RoomMention } from './context.ts';
import {parseAuthorizationRecord,type AuthorizationRecord} from '../work/connection-report.ts';

export type EkkoConnection = { id: string; deviceId: string; accountUserId: number; accountName: string; state: string; authorization?: AuthorizationRecord };
export type EkkoRoom = { id: string; name: string; description?: string; createdAt?: string; updatedAt?: string };
export type EkkoAgent = { id?: string; roomId?: string; agentId: string; name: string; agent?: string; avatar?: string };
export type EkkoMessage = { id: string; roomId: string; senderId?: string | number; senderName?: string; content: string; timestamp?: string; role?: string; isStreaming?: boolean; mentions?: RoomMention[];
  /** Paired Bridge projection capability, generated locally; not an upstream service version or sender identity. */
  preservesStreamingFlagPresence?: boolean;
};
export type EkkoEvent = { event: string; data: Record<string, unknown> };
export type EkkoSendPayload = { clientMessageId: string; content: string; mentions: ReadonlyArray<RoomMention> };
export type EkkoExpectedIdentity = Readonly<{ connectionId: string; deviceId: string; accountUserId: number }>;

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const ERROR_CODE = /^[a-z0-9_]{1,60}$/;

function identityHeaders(expected: EkkoExpectedIdentity): Record<string,string> {
  if (!expected || typeof expected.connectionId !== 'string' || !ID.test(expected.connectionId) ||
      typeof expected.deviceId !== 'string' || !ID.test(expected.deviceId) || !Number.isSafeInteger(expected.accountUserId) || expected.accountUserId <= 0) {
    throw new BridgeError('发送或核对前需提供有效的冻结连接身份', 400, 'expected_identity_invalid');
  }
  return { 'X-Ekko-Connection-Id': expected.connectionId, 'X-Ekko-Device-Id': expected.deviceId, 'X-Ekko-Account-User-Id': String(expected.accountUserId) };
}

function localBridgeUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new BridgeError('房间 Bridge 地址必须是本机回环地址', 400, 'invalid_bridge_url'); }
  if (parsed.protocol !== 'http:' || !LOCAL_HOSTS.has(parsed.hostname) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new BridgeError('房间 Bridge 地址必须是本机回环地址', 400, 'invalid_bridge_url');
  }
  return parsed.origin;
}
function pathId(value: string): string {
  if (!ID.test(value)) throw new BridgeError('房间或消息 ID 无效', 400, 'invalid_id');
  return encodeURIComponent(value);
}
function query(params: Record<string, string | number | undefined>, maxLimit: number): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (key === 'limit' && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maxLimit) ||
        key === 'offset' && (!Number.isSafeInteger(value) || Number(value) < 0)) throw new BridgeError('分页参数无效', 400, 'pagination_invalid');
    if (key === 'before') pathId(String(value));
    search.set(key, String(value));
  }
  return search.size ? `?${search}` : '';
}
function safeConnection(value: unknown): EkkoConnection | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.deviceId !== 'string' || typeof row.accountUserId !== 'number' ||
      typeof row.accountName !== 'string' || typeof row.state !== 'string') return null;
  const authorization=parseAuthorizationRecord(row.authorization);
  return { id: row.id, deviceId: row.deviceId, accountUserId: row.accountUserId, accountName: row.accountName, state: row.state, ...(authorization?{authorization}:{}) };
}

export class EkkoBridgeClient {
  constructor(private readonly config: BridgeConfig) {}

  private headers(documentRootId?: string): Record<string, string> {
    const token = this.config.capabilityToken;
    if (!token || !isValidByteStringHeaderValue(token)) throw new BridgeError('请先配对本机 Bridge', 401, 'bridge_capability_required');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Siyuan-Collab-Token': token };
    if (documentRootId !== undefined) {
      if (!isValidDocumentRootId(documentRootId) || !isValidByteStringHeaderValue(documentRootId)) {
        throw new BridgeError('请先打开一个思源文档', 400, 'invalid_document_root');
      }
      headers['X-Siyuan-Document-Root'] = documentRootId;
    }
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}, documentRootId?: string, expectedHeaders: Record<string,string> = {}): Promise<T> {
    const base = localBridgeUrl(this.config.bridgeUrl);
    const headers = { ...this.headers(documentRootId), ...expectedHeaders };
    const response = await fetch(`${base}${path}`, { ...init, headers, signal: init.signal ?? this.config.signal,
      credentials: 'omit', cache: 'no-store', redirect: 'error' });
    let data: unknown;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const received = (data as { error?: { code?: unknown } })?.error?.code;
      const code = typeof received === 'string' && ERROR_CODE.test(received) ? received : 'ekko_unavailable';
      throw new BridgeError('EKKO 房间请求失败，请核对连接、账号或房间权限', response.status, code);
    }
    return data as T;
  }

  async connection(): Promise<{ connection: EkkoConnection | null }> {
    const result = await this.request<{ connection: unknown }>('/ekko/connection');
    return { connection: safeConnection(result.connection) };
  }
  async pair(input: { baseUrl: string; username: string; password: string }): Promise<{ connection: EkkoConnection | null }> {
    const result = await this.request<{ connection: unknown }>('/ekko/pair', { method: 'POST', body: JSON.stringify(input) });
    return { connection: safeConnection(result.connection) };
  }
  rooms(options: { offset?: number; limit?: number }, expectedIdentity: EkkoExpectedIdentity) {
    return this.request<{ rooms: EkkoRoom[]; total: number; hasMore: boolean }>(`/ekko/rooms${query(options, 50)}`, {}, undefined, identityHeaders(expectedIdentity));
  }
  room(roomId: string, options: { before?: string; limit?: number }, expectedIdentity: EkkoExpectedIdentity) {
    return this.request<{ room: EkkoRoom; messages: EkkoMessage[]; agents: EkkoAgent[]; hasMore: boolean }>(
      `/ekko/rooms/${pathId(roomId)}${query(options, 150)}`, {}, undefined, identityHeaders(expectedIdentity));
  }
  async send(roomId: string, payload: EkkoSendPayload, expectedIdentity: EkkoExpectedIdentity, documentRootId = this.config.documentRootId) {
    const expectedHeaders = identityHeaders(expectedIdentity);
    if (!documentRootId) throw new BridgeError('发送前请先打开思源文档', 400, 'invalid_document_root');
    pathId(payload.clientMessageId);
    if (typeof payload.content !== 'string' || !payload.content.trim() || payload.content.length > 120_000 || !Array.isArray(payload.mentions)) {
      throw new BridgeError('房间消息无效或超过上限', 400, 'message_invalid');
    }
    return this.request<{ state: 'sent' | 'unknown'; messageId?: string }>(`/ekko/rooms/${pathId(roomId)}/messages`,
      { method: 'POST', body: JSON.stringify({ clientMessageId: payload.clientMessageId, content: payload.content, mentions: payload.mentions }) }, documentRootId, expectedHeaders);
  }
  sendStatus(roomId: string, clientMessageId: string, expectedIdentity: EkkoExpectedIdentity) {
    const expectedHeaders = identityHeaders(expectedIdentity);
    return this.request<{ state: 'sent' | 'unknown'; messageId?: string }>(`/ekko/rooms/${pathId(roomId)}/send-status/${pathId(clientMessageId)}`, {}, undefined, expectedHeaders);
  }
  async events(roomId: string, onEvent: (event: EkkoEvent) => void, signal: AbortSignal | undefined, expectedIdentity: EkkoExpectedIdentity): Promise<void> {
    const base = localBridgeUrl(this.config.bridgeUrl);
    const response = await fetch(`${base}/ekko/rooms/${pathId(roomId)}/events`, { method: 'GET',
      headers: { ...this.headers(), ...identityHeaders(expectedIdentity), Accept: 'text/event-stream' }, signal: signal ?? this.config.signal,
      credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const received = data?.error?.code;
      throw new BridgeError('EKKO 房间事件连接失败，请核对房间权限', response.status,
        typeof received === 'string' && ERROR_CODE.test(received) ? received : 'ekko_events_unavailable');
    }
    if (!response.body) throw new BridgeError('EKKO 房间事件流不可用', 502, 'ekko_events_unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const emit = (block: string) => {
      let event = 'message';
      const lines: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim() || event;
        else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
      }
      if (!lines.length || lines.join('') === '[DONE]') return;
      let data: unknown;
      try { data = JSON.parse(lines.join('\n')); } catch { return; }
      if (data && typeof data === 'object' && !Array.isArray(data)) onEvent({ event, data: data as Record<string, unknown> });
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) emit(block);
      }
      buffer += decoder.decode();
      if (buffer.trim()) emit(buffer);
    } finally { reader.releaseLock(); }
  }
}
