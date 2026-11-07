const phases = new Set(['intent', 'streaming', 'queued', 'unknown', 'completed', 'failed']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const exactKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
export const terminalRun = run => run?.phase === 'completed' || run?.phase === 'failed';
export function assertRunIdentity(identity) {
  if (!exactKeys(identity, ['connectionId', 'kind', 'profile', 'storedSessionId', 'installId']) || !text(identity.connectionId) || !['serve', 'studio'].includes(identity.kind) || !text(identity.profile)
    || !(identity.storedSessionId === null || text(identity.storedSessionId))
    || (identity.kind === 'studio' ? identity.installId !== null || !text(identity.storedSessionId) : !text(identity.installId))) throw new Error('Hermes 运行身份格式错误；已停止写入');
  return identity;
}
export function assertRunOwner(owner) {
  if (!exactKeys(owner, owner?.kind === 'v2' ? ['kind', 'chatId', 'documentRootId'] : ['kind', 'sessionId', 'documentRootId'])
    || !['v2', 'legacy-studio'].includes(owner.kind) || typeof owner.documentRootId !== 'string' || !/^\d{14}-[a-z0-9]{7}$/.test(owner.documentRootId)
    || !text(owner.kind === 'v2' ? owner.chatId : owner.sessionId)) throw new Error('Hermes 运行归属格式错误；已停止写入');
  return owner;
}
export function assertSessionRun(run, row, key, store) {
  if (!exactKeys(run, ['schemaVersion', 'attemptId', 'phase', 'owner', 'identity', 'receipt']) || run.schemaVersion !== 1
    || typeof run.attemptId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run.attemptId) || !phases.has(run.phase)) throw new Error('Hermes 运行记录格式错误；已停止写入');
  assertRunIdentity(run.identity); assertRunOwner(run.owner);
  if (terminalRun(run)) {
    if (!exactKeys(run.receipt, ['source', 'terminal', 'verified']) || run.receipt.source !== run.identity.kind || run.receipt.terminal !== run.phase || run.receipt.verified !== true) throw new Error('Hermes 运行终结证据无效；已停止写入');
  } else if (Object.hasOwn(run, 'receipt')) throw new Error('Hermes 运行终结证据无效；已停止写入');
  if (row) {
    const valid = store === 'v2'
      ? run.owner.kind === 'v2' && run.owner.chatId === key && ['connectionId', 'kind', 'profile', 'storedSessionId', 'installId'].every(field => row[field] === run.identity[field])
      : run.owner.kind === 'legacy-studio' && run.owner.sessionId === row.id && key === `${row.documentRootId}:${row.id}` && row.source === 'studio' && run.identity.kind === 'studio' && row.profile === run.identity.profile && row.id === run.identity.storedSessionId;
    if (!valid || row.documentRootId !== run.owner.documentRootId) throw new Error('Hermes 运行归属不匹配；已停止写入');
  }
  return run;
}
