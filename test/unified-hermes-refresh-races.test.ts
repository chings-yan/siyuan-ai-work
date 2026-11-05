import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectController } from '../src/reconnect.ts';
import { fixture, link, W, D } from './shared-ui-fixture.ts';
const serve = { id: 'serve-local', kind: 'serve', profile: 'default', installId: 'fictional-install', displayName: 'Safe', state: 'ready' };
const studio = { id: 'studio-default', kind: 'studio', profile: 'default', installId: null, displayName: 'Safe', state: 'ready' };
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function reconnector(p: any) { let success = 0, failure = 0, retries = 0; const controller = new ReconnectController({ hasToken: () => true, refresh: () => p.syncHermesSessions(), onFailure: e => { failure++; p.updateConnectionUI(false, e); }, onSuccess: () => { success++; p.updateConnectionUI(true); }, scheduler: { set: () => { retries++; return 0; }, clear: () => { } } }); return { controller, success: () => success, failure: () => failure, retries: () => retries }; }
for (const phase of ['connections', 'history', 'pending'] as const)
    for (const change of ['chat', 'default', 'work', 'url', 'token', 'document', 'navigation', 'generation'] as const)
        for (const outcome of ['reject', 'resolve'] as const)
            test(`actual bundle stale refresh ${phase} ${outcome} after ${change} leaves current service untouched`, async () => {
                const f = await fixture(), originalFetch = globalThis.fetch, gate = deferred<any>(), entered = deferred<void>();
                let reconnect: ReturnType<typeof reconnector> | undefined;
                try {
                    const old = f.p.threadFromLink(link('old-refresh-chat')), next = f.p.threadFromLink({ ...link('next-refresh-chat'), adapter: 'studio', connectionId: 'studio-default', installId: null });
                    f.p.threads = [old, next];
                    f.p.activeThreadId = old.id;
                    f.p.connectionViews = [serve, studio];
                    f.p.activateDraft();
                    f.input.value = 'fictional untouched original draft';
                    f.input.dispatchEvent(new f.dom.window.Event('input'));
                    const threads = structuredClone(f.p.threads);
                    await f.p.workStore.saveResume({ workId: W, documentId: W, focusBlockId: null, chatId: old.id, taskId: null, updatedAt: '2026-10-10' });
                    await f.p.workStore.setPending({ id: 'chat-run:' + old.id, kind: 'chat', workId: W, state: 'unknown', details: 'fictional durable queue', updatedAt: '2026-10-10' });
                    const resume = await f.p.workStore.getResume(W), pending = await f.p.workStore.listPending();
                    const listPending = f.p.workStore.listPending.bind(f.p.workStore);
                    if (phase === 'pending')
                        f.p.workStore.listPending = async () => { entered.resolve(); return gate.promise; };
                    const requests: string[] = [];
                    globalThis.fetch = async (u, i) => { assert.equal(i?.method || 'GET', 'GET'); const path = new URL(String(u)).pathname; requests.push(path); if (path === '/connections') {
                        if (phase === 'connections') {
                            entered.resolve();
                            return gate.promise;
                        }
                        return Response.json({ data: [serve, studio] });
                    } assert.equal(path, '/chats/old-refresh-chat/messages'); if (phase === 'history') {
                        entered.resolve();
                        return gate.promise;
                    } return Response.json({ data: [{ role: 'assistant', content: 'old response must not replace history' }] }); };
                    reconnect = reconnector(f.p);
                    const refreshing = reconnect.controller.refreshNow();
                    await entered.promise;
                    if (change === 'chat') {
                        f.p.activeThreadId = next.id;
                        f.p.selectedConnectionId = 'studio-default';
                        f.p.confirmedConnectionId = 'studio-default';
                    }
                    if (change === 'default') {
                        f.p.selectedConnectionId = 'studio-default';
                        f.p.confirmedConnectionId = 'studio-default';
                    }
                    if (change === 'work')
                        f.p.workController.workId = D;
                    if (change === 'url')
                        f.p.bridgeUrl = 'http://127.0.0.1:8799';
                    if (change === 'token')
                        f.p.bridgeToken = 'fictional-later-token';
                    if (change === 'document')
                        f.setDocument(D);
                    if (change === 'navigation')
                        f.p.workController.navigationSequence++;
                    if (change === 'generation')
                        f.p.workLoadSeq++;
                    f.p.updateConnectionUI(true);
                    const badge = f.root.querySelector('[data-connection-label]')!.textContent;
                    if (outcome === 'reject')
                        gate.reject(Error('fictional obsolete refresh failure'));
                    else
                        gate.resolve(phase === 'pending' ? pending : Response.json(phase === 'connections' ? { data: [serve, studio] } : { data: [{ role: 'assistant', content: 'obsolete history' }] }));
                    await refreshing;
                    assert.equal(reconnect.failure(), 0);
                    assert.equal(reconnect.success(), 0);
                    assert.equal(reconnect.retries(), 1);
                    assert.equal(f.p.connectionViews.find((v: any) => v.id === 'studio-default').state, 'ready');
                    assert.equal(f.root.querySelector('[data-connection-label]')!.textContent, badge);
                    assert.equal(f.input.value, 'fictional untouched original draft');
                    assert.deepEqual(f.p.threads, threads);
                    assert.deepEqual(await f.p.workStore.getResume(W), resume);
                    f.p.workStore.listPending = listPending;
                    assert.deepEqual(await f.p.workStore.listPending(), pending);
                    assert.ok(requests.every(path => path === '/connections' || path === '/chats/old-refresh-chat/messages'));
                }
                finally {
                    reconnect?.controller.unload();
                    globalThis.fetch = originalFetch;
                    f.close();
                }
            });
for (const phase of ['connections', 'history', 'pending'] as const)
    test(`actual bundle current refresh ${phase} failure remains visible and schedules retry`, async () => {
        const f = await fixture(), originalFetch = globalThis.fetch;
        let reconnect: ReturnType<typeof reconnector> | undefined;
        try {
            const thread = f.p.threadFromLink(link('current-failure'));
            f.p.threads = [thread];
            f.p.activeThreadId = thread.id;
            f.p.connectionViews = [serve];
            if (phase === 'pending')
                f.p.workStore.listPending = async () => { throw Error('fictional current pending read failure'); };
            globalThis.fetch = async (u) => { if (phase === 'connections' || phase === 'history' && !String(u).endsWith('/connections'))
                throw Error('fictional current read failure'); return Response.json(String(u).endsWith('/connections') ? { data: [serve] } : { data: [] }); };
            reconnect = reconnector(f.p);
            await reconnect.controller.refreshNow();
            assert.equal(reconnect.failure(), 1);
            assert.equal(reconnect.success(), 0);
            assert.equal(reconnect.retries(), 1);
            assert.equal(f.p.connectionOk, false);
            assert.equal(f.p.connectionViews[0].state, 'offline');
        }
        finally {
            reconnect?.controller.unload();
            globalThis.fetch = originalFetch;
            f.close();
        }
    });
for (const phase of ['history', 'pending'] as const)
    for (const outcome of ['reject', 'resolve'] as const)
        test(`actual bundle older same Chat ${phase} ${outcome} cannot overwrite newer read success or emit failure`, async () => {
            const f = await fixture(), originalFetch = globalThis.fetch, gate = deferred<any>(), entered = deferred<void>();
            let reconnect: ReturnType<typeof reconnector> | undefined;
            try {
                const thread = f.p.threadFromLink(link('same-refresh-chat'));
                f.p.threads = [thread];
                f.p.activeThreadId = thread.id;
                f.p.connectionViews = [serve];
                let histories = 0, pendingReads = 0;
                const listPending = f.p.workStore.listPending.bind(f.p.workStore);
                if (phase === 'pending')
                    f.p.workStore.listPending = async () => { if (pendingReads++ === 0) {
                        entered.resolve();
                        return gate.promise;
                    } return listPending(); };
                globalThis.fetch = async (u) => { if (String(u).endsWith('/connections'))
                    return Response.json({ data: [serve] }); if (histories++ === 0 && phase === 'history') {
                    entered.resolve();
                    return gate.promise;
                } return Response.json({ data: [{ role: 'assistant', content: 'latest successful history' }] }); };
                reconnect = reconnector(f.p);
                const older = reconnect.controller.refreshNow();
                await entered.promise;
                await f.p.selectChat(f.root, thread.id);
                assert.equal(f.p.chatReadStatus.ready, true);
                assert.equal(f.root.querySelector('[data-connection-label]')!.textContent, '已连接');
                const status = structuredClone(f.p.chatReadStatus), messages = structuredClone(f.p.threads[0].messages);
                if (outcome === 'reject')
                    gate.reject(Error('fictional old same-Chat read failure'));
                else
                    gate.resolve(phase === 'pending' ? [] : Response.json({ data: [{ role: 'assistant', content: 'obsolete first history' }] }));
                await older;
                assert.equal(reconnect.failure(), 0);
                assert.equal(reconnect.success(), 0);
                assert.deepEqual(f.p.chatReadStatus, status);
                assert.deepEqual(f.p.threads[0].messages, messages);
                assert.equal(f.root.querySelector('[data-connection-label]')!.textContent, '已连接');
                assert.equal(f.p.connectionViews[0].state, 'ready');
            }
            finally {
                reconnect?.controller.unload();
                globalThis.fetch = originalFetch;
                f.close();
            }
        });
test('actual bundle stale startup settings rejection preserves a later explicit Bridge and target', async () => {
    const f = await fixture(), gate = deferred<any>();
    try {
        f.p.loadData = async () => gate.promise;
        f.p.addTab = () => { };
        f.p.addIcons = () => { };
        f.p.addDock = () => ({});
        f.p.eventBus = { on: () => { } };
        f.p.onload();
        f.p.bridgeUrl = 'http://127.0.0.1:8799';
        f.p.bridgeToken = 'fictional-new-explicit-token';
        f.p.selectedConnectionId = 'studio-default';
        f.p.confirmedConnectionId = 'studio-default';
        const next = f.p.threadFromLink({ ...link('new-startup-chat'), adapter: 'studio', connectionId: 'studio-default', installId: null });
        f.p.threads = [next];
        f.p.activeThreadId = next.id;
        f.p.connectionViews = [serve, studio];
        f.p.updateConnectionUI(true);
        gate.reject(Error('obsolete startup disk failure'));
        await new Promise(r => setTimeout(r, 10));
        assert.equal(f.p.connectionViews.find((v: any) => v.id === 'studio-default').state, 'ready');
        assert.equal(f.p.connectionOk, true);
        assert.equal(f.p.bridgeUrl, 'http://127.0.0.1:8799');
        assert.equal(f.p.bridgeToken, 'fictional-new-explicit-token');
        assert.equal(f.root.querySelector('[data-connection-label]')!.textContent, '已连接');
        f.p.observer?.disconnect();
    }
    finally {
        f.close();
    }
});
for (const kind of ['disk', 'malformed'] as const)
    test(`actual bundle current startup ${kind} failure remains observable`, async () => {
        const f = await fixture();
        try {
            f.p.loadData = async () => { if (kind === 'disk')
                throw Error('current startup disk failure'); return { hermesConnectionId: 'http://invalid-target' }; };
            f.p.addTab = () => { };
            f.p.addIcons = () => { };
            f.p.addDock = () => ({});
            f.p.eventBus = { on: () => { } };
            f.p.connectionViews = [serve];
            f.p.updateConnectionUI(true);
            f.p.onload();
            await new Promise(r => setTimeout(r, 10));
            assert.equal(f.p.connectionOk, false);
            assert.equal(f.p.connectionViews[0].state, 'offline');
            assert.equal(f.p.selectedConnectionId, 'serve-local');
            f.p.observer?.disconnect();
        }
        finally {
            f.close();
        }
    });
