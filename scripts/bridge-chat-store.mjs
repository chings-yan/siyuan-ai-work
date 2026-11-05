import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBindings } from './studio-client.mjs';

const queues = new Map();
const ROOT_PATTERN = /^\d{14}-[a-z0-9]{7}$/;
const CHAT_PATTERN = /^(?:[A-Za-z0-9_-]{1,128}|siyuan:\d{14}-[a-z0-9]{7}:[A-Za-z0-9_-]{1,128})$/;

export function validChatId(value) { return typeof value === 'string' && CHAT_PATTERN.test(value); }

function assertValidBindings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Bridge v2 绑定数据格式错误；已停止写入');
  for (const [key, row] of Object.entries(value)) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || !validChatId(key) || row.chatId !== key
      || typeof row.connectionId !== 'string' || !row.connectionId
      || !['serve', 'studio', 'legacy-api'].includes(row.kind)
      || typeof row.profile !== 'string' || !row.profile
      || !ROOT_PATTERN.test(row.documentRootId)
      || typeof row.title !== 'string' || !row.title
      || !['pending', 'creating', 'ready', 'unknown'].includes(row.state)
      || !(row.storedSessionId === null || (typeof row.storedSessionId === 'string' && row.storedSessionId))
      || !(row.installId === null || (typeof row.installId === 'string' && row.installId))
      || !(row.anchor === null || (row.anchor && typeof row.anchor.messageId === 'string' && /^[0-9a-f]{64}$/.test(row.anchor.sha256)))
      || (row.state === 'ready' && !row.storedSessionId)) throw new Error('Bridge v2 绑定数据格式错误；已停止写入');
  }
  return value;
}

export async function readChatBindings(file) {
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
  let value;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Bridge v2 绑定数据损坏；已停止写入'); }
  return assertValidBindings(value);
}

export async function writeChatBindingsAtomic(file, value) {
  await readChatBindings(file);
  assertValidBindings(value);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export async function mutateChatBindings(file, transform) {
  const previous = queues.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = await readChatBindings(file);
    const next = await transform(current);
    if (next !== undefined) await writeChatBindingsAtomic(file, next);
    return next;
  });
  queues.set(file, operation);
  try { return await operation; }
  finally { if (queues.get(file) === operation) queues.delete(file); }
}

export async function mutateLegacyBindings(file, transform) {
  const key = `legacy:${file}`;
  const previous = queues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = await readBindings(file);
    const next = await transform(current);
    if (next === undefined) return;
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(temp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  });
  queues.set(key, operation);
  try { await operation; }
  finally { if (queues.get(key) === operation) queues.delete(key); }
}

export function assertChatScope(binding, documentRootId) {
  if (!binding || binding.documentRootId !== documentRootId) throw Object.assign(new Error('Chat 不属于当前文档'), { status: 403, code: 'chat_scope_denied' });
  return true;
}
