import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectController } from '../src/reconnect.ts';

type Job = () => void;
function scheduler() {
  const jobs: Job[] = [];
  return { jobs, set: (job: Job, _delayMs?: number) => { jobs.push(job); return jobs.length; }, clear: (id: unknown) => { jobs[Number(id) - 1] = () => undefined; } };
}

 test('failed refresh schedules one retry and a later success updates status and stops retries', async () => {
  const clock = scheduler(); const states: string[] = []; let calls = 0;
  const controller = new ReconnectController({ hasToken: () => true, delayMs: 5000, scheduler: clock, refresh: async () => { calls++; if (calls === 1) throw new Error('offline'); }, onFailure: () => states.push('failed'), onSuccess: () => states.push('connected') });
  await controller.refreshNow();
  assert.deepEqual(states, ['failed']); assert.equal(clock.jobs.length, 1);
  clock.jobs[0](); await Promise.resolve();
  assert.equal(calls, 2); assert.deepEqual(states, ['failed', 'connected']); assert.equal(clock.jobs.length, 1);
});

test('same-time refresh requests and timers are coalesced', async () => {
  const clock = scheduler(); let release!: () => void; let calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const controller = new ReconnectController({ hasToken: () => true, scheduler: clock, refresh: async () => { calls++; await pending; }, onFailure: () => undefined, onSuccess: () => undefined });
  const a = controller.refreshNow(); const b = controller.refreshNow(); controller.scheduleRetry(); controller.scheduleRetry();
  assert.equal(calls, 1); assert.equal(clock.jobs.length, 1); release(); await Promise.all([a, b]);
});

test('missing token never retries', async () => {
  const clock = scheduler(); let calls = 0;
  const controller = new ReconnectController({ hasToken: () => false, scheduler: clock, refresh: async () => { calls++; }, onFailure: () => undefined, onSuccess: () => undefined });
  await controller.refreshNow(); controller.scheduleRetry();
  assert.equal(calls, 0); assert.equal(clock.jobs.length, 0);
});

test('unload clears pending retry timer', async () => {
  const clock = scheduler(); const controller = new ReconnectController({ hasToken: () => true, scheduler: clock, refresh: async () => { throw new Error('offline'); }, onFailure: () => undefined, onSuccess: () => undefined });
  await controller.refreshNow(); assert.equal(clock.jobs.length, 1); controller.unload(); clock.jobs[0](); await Promise.resolve();
});

test('success clears a previously scheduled retry timer', async () => {
  const clock = scheduler(); let calls = 0;
  const controller = new ReconnectController({ hasToken: () => true, scheduler: clock, refresh: async () => { calls++; }, onFailure: () => undefined, onSuccess: () => undefined });
  controller.scheduleRetry(); await controller.refreshNow(); assert.equal(calls, 1); assert.equal(clock.jobs.length, 1);
});
