import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readChatBindings, mutateChatBindings, mutateLegacyBindings } from './bridge-chat-store.mjs';
import { readBindings } from './studio-client.mjs';
import { assertRunIdentity, assertRunOwner, assertSessionRun, terminalRun } from './hermes-session-run-record.mjs';

// One upgraded Bridge process coordinates both files; each file retains its atomic transaction.
const queues = new Map();
const sameIdentity = (a, b) => ['connectionId', 'kind', 'profile', 'storedSessionId', 'installId'].every(key => a[key] === b[key]);
const sameOwner = (a, b) => a?.kind === b?.kind && a.documentRootId === b.documentRootId && (a.kind === 'v2' ? a.chatId === b.chatId : a.sessionId === b.sessionId);
const error = code => Object.assign(new Error(code === 'session_busy' ? '这段对话正在处理' : '上次运行结果待核对'), { status: 409, code });
const ambiguous = row => ['unknown', 'creating'].includes(row.state) || ['queued', 'unknown'].includes(row.lastRunState) || (row.kind === 'serve' && row.state === 'pending' && row.storedSessionId);
export function createSessionRunCoordinator({ bindingsV2File, bindingsFile }) {
  const queueKey = JSON.stringify([resolve(bindingsV2File), resolve(bindingsFile)]);
  const live = new Map();
  const serial = async operation => {
    const previous = queues.get(queueKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    queues.set(queueKey, next);
    try { return await next; } finally { if (queues.get(queueKey) === next) queues.delete(queueKey); }
  };
  const scan = async (identity, owner, excluding) => {
    assertRunIdentity(identity);
    const [v2, legacy] = await Promise.all([readChatBindings(bindingsV2File), readBindings(bindingsFile)]);
    const blockers = [];
    for (const [store, rows] of [['v2', v2], ['legacy', legacy]]) for (const row of Object.values(rows)) {
      if (!row || typeof row !== 'object') continue;
      const rowOwner = store === 'v2' ? { kind: 'v2', chatId: row.chatId, documentRootId: row.documentRootId } : { kind: 'legacy-studio', sessionId: row.id, documentRootId: row.documentRootId };
      const matches = row.run ? sameIdentity(row.run.identity, identity) && (identity.storedSessionId !== null || sameOwner(rowOwner, owner))
        : store === 'v2' ? sameIdentity(row, identity) && (identity.storedSessionId !== null || sameOwner(rowOwner, owner))
          : identity.kind === 'studio' && row.id === identity.storedSessionId && row.profile === identity.profile && row.source === 'studio';
      if (!matches || (excluding && row.run?.attemptId === excluding)) continue;
      if (row.run && !terminalRun(row.run)) blockers.push({ state: row.run.phase, isOwner: sameOwner(rowOwner, owner) });
      else if (!row.run && ambiguous(row)) blockers.push({ state: 'unknown', isOwner: sameOwner(rowOwner, owner) });
    }
    return blockers.find(item => item.state === 'unknown') || blockers[0] || { state: 'idle', isOwner: false };
  };
  const mutateOwner = async (owner, transform) => {
    const key = owner.kind === 'v2' ? owner.chatId : `${owner.documentRootId}:${owner.sessionId}`;
    const mutate = owner.kind === 'v2' ? mutateChatBindings : mutateLegacyBindings;
    await mutate(owner.kind === 'v2' ? bindingsV2File : bindingsFile, rows => {
      const row = rows[key];
      if (!row || row.documentRootId !== owner.documentRootId) throw error('session_identity_unknown');
      const next = transform(row);
      if (!next) return undefined;
      assertSessionRun(next.run, next, key, owner.kind === 'v2' ? 'v2' : 'legacy');
      return { ...rows, [key]: next };
    });
  };
  const currentLease = lease => live.get(lease?.attemptId) === lease;
  return {
    begin: (owner, identity) => serial(async () => {
      assertRunOwner(owner); assertRunIdentity(identity);
      const status = await scan(identity, owner);
      if (status.state !== 'idle') throw error(status.state === 'unknown' ? 'session_result_unknown' : 'session_busy');
      const lease = Object.freeze({ attemptId: randomUUID(), owner: Object.freeze({ ...owner }) });
      const run = { schemaVersion: 1, attemptId: lease.attemptId, phase: 'intent', owner: { ...owner }, identity: { ...identity } };
      await mutateOwner(owner, row => {
        // A newly resolved connection cannot replace this owner's unfinished attempt.
        if (row.run && !terminalRun(row.run)) {
          if (!sameIdentity(row.run.identity, identity)) throw error('session_identity_unknown');
          throw error(row.run.phase === 'unknown' ? 'session_result_unknown' : 'session_busy');
        }
        return { ...row, run };
      });
      live.set(lease.attemptId, lease);
      return lease;
    }),
    attachSession: (lease, identity) => serial(async () => {
      if (!currentLease(lease)) return false;
      assertRunIdentity(identity);
      const status = await scan(identity, lease.owner, lease.attemptId);
      if (status.state !== 'idle') throw error(status.state === 'unknown' ? 'session_result_unknown' : 'session_busy');
      await mutateOwner(lease.owner, row => {
        if (row.run?.attemptId !== lease.attemptId) return undefined;
        const old = row.run.identity;
        if (old.storedSessionId !== null || !identity.storedSessionId || !sameIdentity({ ...old, storedSessionId: identity.storedSessionId }, identity) || lease.owner.kind !== 'v2') throw error('session_identity_unknown');
        return { ...row, storedSessionId: identity.storedSessionId, run: { ...row.run, identity: { ...identity } } };
      });
      return true;
    }),
    transition: (lease, phase, receipt) => serial(async () => {
      if (!currentLease(lease)) return false;
      let changed = false;
      await mutateOwner(lease.owner, row => {
        if (row.run?.attemptId !== lease.attemptId || terminalRun(row.run)) return undefined;
        // Late acceptance cannot reopen a queued/unknown attempt.
        if (phase === 'streaming' && row.run.phase !== 'intent') return undefined;
        const run = { ...row.run, phase, ...(receipt === undefined ? {} : { receipt }) };
        assertSessionRun(run); changed = true;
        return { ...row, run };
      });
      return changed;
    }),
    inspect: (identity, owner) => serial(() => scan(identity, owner)),
    release: lease => { if (currentLease(lease)) live.delete(lease.attemptId); },
  };
}
