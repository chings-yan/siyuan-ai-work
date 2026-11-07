import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { inspectLocalBridge } from '../src/work/connection-settings.ts';
import { SettingsDialog } from '../src/work/settings-dialog.ts';
import { fixture, link, W, D, tick } from './shared-ui-fixture.ts';
const serve = { id: 'serve-local', kind: 'serve', profile: 'default', installId: 'fictional-install', displayName: 'private-name <img src=x>', state: 'ready' };
const studio = { id: 'studio-default', kind: 'studio', profile: 'default', installId: null, displayName: 'private desktop', state: 'ready' };
const config = { bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: 'fictional-token' };
function reads(views: any[], paths: string[] = [], status = 200): typeof fetch { return async (u, init) => { assert.equal(init?.method || 'GET', 'GET'); paths.push(new URL(String(u)).pathname); return Response.json(String(u).endsWith('/health') ? { ok: true, service: 'siyuan-ai-collab-bridge', version: '999.1' } : { data: views }, { status: String(u).endsWith('/health') ? 200 : status }); }; }
for (const [name, views, id, choose] of [['Studio', [studio], 'studio-default', false], ['Serve', [serve], 'serve-local', false], ['multiple', [serve, studio], undefined, true], ['none', [], undefined, false], ['legacy', [{ ...studio, id: 'legacy-api', kind: 'legacy-api' }], undefined, false]] as const)
    test(`inspection explicit auto detects ${name} without version selection`, async () => {
        const result: any = await inspectLocalBridge(config, reads([...views]));
        assert.equal(result.bridgeAuthenticated, true);
        assert.equal(result.selectedConnectionId, id);
        assert.equal(result.requiresSelection, choose);
        assert.equal(result.hermesReady, Boolean(id));
        assert.doesNotMatch(JSON.stringify(result), /private-name|private desktop|<img/);
    });
for (const state of ['auth_missing', 'auth_failed', 'offline', 'configured', 'incompatible', 'install_changed'])
    test(`inspection accepts ${state} and explains next action`, async () => {
        const result = await inspectLocalBridge({ ...config, selectedConnectionId: 'studio-default' }, reads([{ ...studio, state }]));
        assert.equal(result.bridgeAuthenticated, true);
        assert.equal(result.hermesReady, false);
        assert.match(result.message, state === 'auth_missing' ? /凭证|授权/ : state === 'auth_failed' ? /认证|拒绝/ : state === 'configured' ? /尚未核验/ : state === 'offline' ? /启动|运行/ : state === 'incompatible' ? /协议|能力/ : /身份/);
    });
test('inspection retains explicit offline preference with another ready service', async () => { const result: any = await inspectLocalBridge({ ...config, selectedConnectionId: 'studio-default' }, reads([serve, { ...studio, state: 'offline' }])); assert.equal(result.selectedConnectionId, 'studio-default'); assert.equal(result.hermesReady, false); assert.equal(result.requiresSelection, false); });
for (const views of [[serve, serve], [{ ...serve, installId: null }], [{ ...studio, id: 'http://private-address' }], [{ ...studio, profile: '' }]])
    test('inspection rejects malformed identity without saving', async () => { assert.equal((await inspectLocalBridge(config, reads(views))).bridgeAuthenticated, false); });
for (const token of ['', 'bad\nheader', '中文'])
    test('missing or invalid Bridge token never reaches authenticated endpoint', async () => { const paths: string[] = []; const result = await inspectLocalBridge({ ...config, capabilityToken: token }, reads([serve], paths)); assert.equal(result.bridgeAuthenticated, false); assert.deepEqual(paths, ['/health']); });
test('rejected Bridge token differs from upstream auth failure', async () => { const result = await inspectLocalBridge(config, reads([serve], [], 401)); assert.equal(result.bridgeAuthenticated, false); assert.match(result.message, /配对凭证未通过/); });
test('settings dropdown is a candidate, preserves pane inputs and renders safe detected results', async () => {
    const dom = new JSDOM('<body><button>设置</button></body>'), doc = dom.window.document;
    let mutations = 0, received: any;
    const dialog = new SettingsDialog(doc, { bridgeUrl: () => config.bridgeUrl, bridgeStatus: () => '', save: async () => { }, connections: () => [serve, studio] as any, currentConnection: () => '', selectConnection: () => { mutations++; }, inspectBridge: async (input) => { received = input; return { url: config.bridgeUrl, message: '请选择检测到的服务', bridgeAuthenticated: true, hermesReady: false, connections: [serve, studio] as any, requiresSelection: true } as any; } });
    const source = doc.querySelector('button')!;
    source.focus();
    dialog.open(source, 'hermes');
    const select = doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')!;
    assert.equal(select.value, '');
    assert.doesNotMatch(select.textContent || '', /版本|共享版|日常版/);
    assert.match(doc.querySelector('[data-companion-info]')!.textContent||'',/配套未提供可识别的能力信息/);
    const url = doc.querySelector<HTMLInputElement>('[data-setting="baseUrl"]')!, token = doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!;
    url.value = 'http://127.0.0.1:8789';
    token.value = 'fictional-unsaved';
    select.value = 'studio-default';
    select.dispatchEvent(new dom.window.Event('change'));
    assert.equal(mutations, 0);
    doc.querySelector<HTMLButtonElement>('[data-settings-action="work"]')!.click();
    doc.querySelector<HTMLButtonElement>('[data-settings-action="hermes"]')!.click();
    assert.equal(token.value, 'fictional-unsaved');
    assert.equal(url.value, 'http://127.0.0.1:8789');
    assert.equal(select.value, 'studio-default');
    doc.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click();
    await tick();
    assert.equal(received.connectionId, 'studio-default');
    assert.ok(doc.querySelector('[data-hermes-results]'));
    assert.doesNotMatch(doc.body.innerHTML, /private-name|private desktop|<img|fictional-unsaved/);
    dialog.close();
    assert.equal(doc.activeElement, source);
    dom.window.close();
});
test('actual bundle detects sole Studio, persists target and preserves Chat identity drafts Resume and unknown operations', async () => {
    const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
    try {
        const old = link('original-local');
        await f.p.workStore.linkChat(old);
        await f.p.workStore.saveResume({ workId: W, documentId: W, focusBlockId: null, chatId: old.chatId, taskId: null, updatedAt: '2026-10-10' });
        await f.p.workStore.setPending({ id: 'chat-run:' + old.chatId, kind: 'chat', workId: W, state: 'unknown', details: 'fictional queued', updatedAt: '2026-10-10' });
        f.p.threads = [f.p.threadFromLink(old)];
        const originalThread = structuredClone(f.p.threads[0]);
        f.p.activeThreadId = old.chatId;
        f.p.activateDraft();
        f.input.value = 'original draft';
        f.input.dispatchEvent(new f.dom.window.Event('input'));
        const pending = await f.p.workStore.listPending(), resume = await f.p.workStore.getResume(W);
        const saved: any = { bridgeUrl: f.p.bridgeUrl, bridgeToken: f.p.bridgeToken, defaultWorkNotebookId: 'fictional-notebook', other: 'keep' };
        const originalLoad = f.p.loadData.bind(f.p);
        f.p.loadData = async (k: string) => k === 'settings' ? saved : originalLoad(k);
        let written: any;
        f.p.saveData = async (k: string, v: any) => { assert.equal(k, 'settings'); written = structuredClone(v); Object.assign(saved, written); };
        const paths: string[] = [];
        globalThis.fetch = reads([studio], paths);
        await f.p.connectSettingsBridge({ url: f.p.bridgeUrl, token: '', detect: false });
        assert.equal(f.p.selectedConnectionId, 'studio-default');
        assert.equal(written.hermesConnectionId, 'studio-default');
        assert.equal(written.other, 'keep');
        assert.equal(written.defaultWorkNotebookId, 'fictional-notebook');
        assert.equal(f.p.activeThreadId, old.chatId);
        assert.equal(f.input.value, 'original draft');
        assert.deepEqual(f.p.threads[0], originalThread);
        assert.deepEqual(await f.p.workStore.listPending(), pending);
        assert.deepEqual(await f.p.workStore.getResume(W), resume);
        assert.deepEqual(paths, ['/health', '/connections']);
    }
    finally {
        globalThis.fetch = originalFetch;
        f.close();
    }
});
for (const views of [[serve, studio], [{ ...studio, state: 'offline' }]])
    test('actual bundle ambiguous or offline inspection saves Bridge without inventing preference', async () => {
        const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = reads(views);
            let written: any;
            const save = f.p.saveData.bind(f.p);
            f.p.saveData = async (k: string, v: any) => { written = v; return save(k, v); };
            await f.p.connectSettingsBridge({ url: f.p.bridgeUrl, token: '', detect: false });
            assert.equal(written.hermesConnectionId, undefined);
            assert.equal(f.p.selectedConnectionId, 'serve-local');
        }
        finally {
            globalThis.fetch = originalFetch;
            f.close();
        }
    });
test('actual bundle failed preference save preserves runtime and unsaved candidate', async () => {
    const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = reads([serve, studio]);
        f.p.connectionViews = [serve, studio];
        f.p.saveData = async () => { throw Error('fictional disk failure'); };
        f.p.openSettings(f.root, 'hermes');
        const select = f.doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')!;
        select.value = 'studio-default';
        select.dispatchEvent(new f.dom.window.Event('change'));
        assert.equal(f.p.selectedConnectionId, 'serve-local');
        f.doc.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click();
        await tick();
        assert.equal(f.p.selectedConnectionId, 'serve-local');
        f.doc.querySelector<HTMLButtonElement>('[data-settings-action="confirm-bridge"]')!.click();
        await tick();
        assert.equal(select.value, 'studio-default');
        assert.equal(f.p.selectedConnectionId, 'serve-local');
        assert.match(f.doc.querySelector('[data-settings-error]')!.textContent || '', /保存结果未确认/);
        assert.equal(f.input.value, '原 Chat 草稿');
        assert.doesNotMatch(f.doc.body.textContent||'',/fictional disk failure/);
    }
    finally {
        globalThis.fetch = originalFetch;
        f.close();
    }
});
for (const phase of ['inspection', 'settings-read', 'save'] as const)
    for (const change of ['preference', 'work', 'document', 'busy', 'pending', 'disk-preference'] as const)
        if (!(phase === 'save' && change === 'disk-preference'))
            test(`actual bundle rejects late ${change} during ${phase}`, async () => {
                const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
                let release!: () => void;
                try {
                    const saved: any = { bridgeUrl: f.p.bridgeUrl, bridgeToken: f.p.bridgeToken }, old = f.p.selectedConnectionId;
                    let writes = 0;
                    let enter!: () => void;
                    const entered = new Promise<void>(r => enter = r), gate = () => new Promise<void>(r => { release = r; enter(); });
                    const fetcher = reads([studio]);
                    globalThis.fetch = async (u, i) => {
                        if (phase === 'inspection' && String(u).endsWith('/connections'))
                            await gate();
                        return fetcher(u, i);
                    };
                    f.p.loadData = async (k: string) => {
                        if (k === 'settings') {
                            if (phase === 'settings-read')
                                await gate();
                            return saved;
                        }
                    };
                    f.p.saveData = async () => {
                        writes++;
                        if (phase === 'save')
                            await gate();
                    };
                    const connecting = f.p.connectSettingsBridge({ url: f.p.bridgeUrl, token: '', detect: false });
                    await Promise.race([entered, new Promise<void>((_, reject) => setTimeout(() => reject(Error("test gate not reached")), 1000))]);
                    if (change === 'preference')
                        f.p.selectedConnectionId = 'externally-selected';
                    if (change === 'work')
                        f.p.workController.workId = D;
                    if (change === 'document')
                        f.setDocument(D);
                    if (change === 'busy')
                        f.p.sendInFlight = true;
                    if (change === 'pending')
                        f.p.pendingProposal = {};
                    if (change === 'disk-preference')
                        saved.hermesConnectionId = 'externally-saved';
                    release();
                    await assert.rejects(connecting, (error:any)=>{assert.match(error.message,/变化|写入|保存结果未确认/);assert.equal(error.saveOutcome,phase==='save'?'unknown':change==='disk-preference'?'failed':'stale');return true;});
                    assert.equal(writes, phase === 'save' ? 1 : 0);
                    assert.equal(f.p.selectedConnectionId, change === 'preference' ? 'externally-selected' : old);
                    assert.equal(f.input.value, '原 Chat 草稿');
                }
                finally {
                    release?.();
                    globalThis.fetch = originalFetch;
                    f.close();
                }
            });
test('actual bundle reload restores saved preference before passive refresh', async () => {
    const f = await fixture({ confirmed: false });
    try {
        const saved = { bridgeUrl: config.bridgeUrl, bridgeToken: config.capabilityToken, hermesConnectionId: 'studio-default' };
        f.p.loadData = async () => saved;
        f.p.addTab = () => { };
        f.p.addIcons = () => { };
        f.p.addDock = () => ({});
        f.p.eventBus = { on: () => { } };
        let seen = '';
        f.p.refreshConnection = async () => { seen = f.p.selectedConnectionId; };
        f.p.onload();
        await tick();
        assert.equal(seen, 'studio-default');
        assert.equal(f.p.confirmedConnectionId, 'studio-default');
        f.p.observer?.disconnect();
    }
    finally {
        f.close();
    }
});
test('actual bundle reconnect loads original Chat when new-use preference is offline', async () => {
    const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
    try {
        const old = link('original-serve');
        await f.p.workStore.linkChat(old);
        f.p.threads = [f.p.threadFromLink(old)];
        f.p.activeThreadId = old.chatId;
        f.p.selectedConnectionId = 'studio-default';
        f.p.confirmedConnectionId = 'studio-default';
        const paths: string[] = [];
        globalThis.fetch = async (u, i) => { assert.equal(i?.method || 'GET', 'GET'); paths.push(new URL(String(u)).pathname); return Response.json(String(u).endsWith('/connections') ? { data: [serve, { ...studio, state: 'offline' }] } : { data: [{ role: 'assistant', content: 'fictional history' }] }); };
        assert.equal(await f.p.syncHermesSessions(), true);
        assert.deepEqual(paths, ['/connections', '/chats/original-serve/messages']);
        assert.equal(f.p.selectedConnectionId, 'studio-default');
        f.p.updateConnectionUI(true);
        assert.equal(f.root.querySelector('[data-connection-label]')!.textContent, '已连接');
        assert.equal(f.p.connectionViews.find((v: any) => v.id === 'studio-default').state, 'offline');
    }
    finally {
        globalThis.fetch = originalFetch;
        f.close();
    }
});
test('actual bundle active old Chat failure does not mark different new-use connection offline', async () => {
    const f = await fixture({ confirmed: false });
    try {
        f.p.threads = [f.p.threadFromLink({ ...link('old-studio'), adapter: 'studio', connectionId: 'studio-default', installId: null })];
        f.p.activeThreadId = 'old-studio';
        f.p.connectionViews = [serve, { ...studio, state: 'offline' }];
        f.p.updateConnectionUI(false, Error('fictional old history failure'));
        assert.equal(f.p.connectionViews.find((v: any) => v.id === 'serve-local').state, 'ready');
        f.p.updateConnectionUI(true);
        assert.notEqual(f.root.querySelector('[data-connection-label]')!.textContent, '已连接');
    }
    finally {
        f.close();
    }
});
test('actual bundle passive refresh rejects malformed connection list', async () => {
    const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
    try {
        globalThis.fetch = reads([{ ...serve, installId: null }]);
        await assert.rejects(f.p.syncHermesSessions(), /响应无效/);
    }
    finally {
        globalThis.fetch = originalFetch;
        f.close();
    }
});
for (const state of ['ready', 'configured'])
    test(`actual bundle explicitly confirms legacy ${state} for association only`, async () => {
        const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
        try {
            const legacy = { ...studio, id: 'legacy-api', kind: 'legacy-api', state };
            globalThis.fetch = reads([legacy]);
            let saved: any;
            const save = f.p.saveData.bind(f.p);
            f.p.saveData = async (k: string, v: any) => {
                if (k === 'settings')
                    saved = v;
                return save(k, v);
            };
            const result = await f.p.connectSettingsBridge({ url: f.p.bridgeUrl, token: '', detect: false, connectionId: 'legacy-api' });
            assert.equal(result.hermesReady, false);
            assert.equal(saved.hermesConnectionId, 'legacy-api');
            assert.equal(f.p.selectedConnectionId, 'legacy-api');
            f.p.renderThreads(f.root);
            assert.equal(f.root.querySelector<HTMLButtonElement>('[data-action="chat-menu-new"]')!.disabled, true);
            assert.match(result.message, /旧|关联/);
            let candidates = 0;
            f.p.bridgeClient = () => ({ listCandidates: async (id: string) => { assert.equal(id, 'legacy-api'); candidates++; return { data: [] }; } });
            await f.p.associateStudio(f.root);
            assert.equal(candidates, 1);
        }
        finally {
            globalThis.fetch = originalFetch;
            f.close();
        }
    });
test('inspection bound includes body and ignores noncooperative fetch abort', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let bodyStarted = false;
    const checking = inspectLocalBridge(config, async (u) => String(u).endsWith('/health') ? Response.json({ ok: true, service: 'siyuan-ai-collab-bridge' }) : { ok: true, status: 200, json: () => { bodyStarted = true; return new Promise(() => { }); } } as Response);
    for (let i = 0; i < 12 && !bodyStarted; i++)
        await Promise.resolve();
    assert.equal(bodyStarted, true);
    t.mock.timers.tick(10000);
    const result = await checking;
    assert.equal(result.bridgeAuthenticated, false);
    assert.match(result.message, /未完成/);
});
test('actual bundle unavailable candidate still saves verified Bridge without confirming candidate', async () => {
    const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
    try {
        const old = f.p.selectedConnectionId;
        globalThis.fetch = reads([{ ...studio, state: 'auth_missing' }]);
        let written: any;
        const save = f.p.saveData.bind(f.p);
        f.p.saveData = async (k: string, v: any) => {
            if (k === 'settings')
                written = v;
            return save(k, v);
        };
        const result = await f.p.connectSettingsBridge({ url: f.p.bridgeUrl, token: '', detect: false, connectionId: 'studio-default' });
        assert.equal(result.bridgeAuthenticated, true);
        assert.equal(result.hermesReady, false);
        assert.equal(written.bridgeToken, 'fictional-token');
        assert.equal(written.hermesConnectionId, undefined);
        assert.equal(f.p.selectedConnectionId, old);
    }
    finally {
        globalThis.fetch = originalFetch;
        f.close();
    }
});
for (const entry of ['new', 'associate', 'work-associate'])
    test(`actual bundle fresh multiple-ready ${entry} entry requires confirmed preference`, async () => {
        const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = reads([serve, studio]);
            await f.p.connectSettingsBridge({ url: f.p.bridgeUrl, token: '', detect: false });
            let sideEffects = 0;
            f.p.bridgeClient = () => ({ createChat: async () => { sideEffects++; assert.fail('no creation before selection'); }, listCandidates: async () => { sideEffects++; assert.fail('no association before selection'); } });
            if (entry === 'new')
                await f.p.startNewChat(f.root);
            else
                await f.p.associateStudio(f.root, entry === 'work-associate' ? W : undefined);
            assert.equal(sideEffects, 0);
            assert.match(f.root.querySelector('[data-status]')!.textContent || '', /选择.*连接|选择.*服务/);
        }
        finally {
            globalThis.fetch = originalFetch;
            f.close();
        }
    });
test('detection retains authenticated current Bridge when its confirmed target is unavailable', async () => { const { detectLocalBridge } = await import('../src/work/connection-settings.ts'); const paths: string[] = []; const result = await detectLocalBridge({ ...config, bridgeUrl: 'http://127.0.0.1:8789', selectedConnectionId: 'studio-default' }, async (u, i) => { paths.push(String(u)); return reads([new URL(String(u)).port === '8789' ? { ...studio, state: 'offline' } : studio])(u, i); }); assert.equal(result.url, 'http://127.0.0.1:8789'); assert.equal(result.hermesReady, false); assert.equal(result.selectedConnectionId, 'studio-default'); assert.deepEqual(paths.map(v => new URL(v).port), ['8789', '8789']); });
test('unavailable services use concise Bridge summary and individual result advice', async () => { const views = [{ ...serve, state: 'auth_missing' }, { ...studio, state: 'auth_failed' }, { ...studio, id: 'legacy-api', kind: 'legacy-api', state: 'configured' }]; const result = await inspectLocalBridge(config, reads(views)); assert.equal(result.bridgeAuthenticated, true); assert.equal(result.hermesReady, false); assert.match(result.message, /下方检测结果/); assert.match(result.message, /Work.*继续/); assert.doesNotMatch(result.message, /缺少服务授权|认证失败或授权|尚未核验读取/); assert.deepEqual(result.connections?.map(v => v.state), ['auth_missing', 'auth_failed', 'configured']); });
test('actual bundle delayed startup preference cannot overwrite a later confirmed choice', async () => {
    const f = await fixture({ confirmed: false });
    let release!: (v: any) => void;
    try {
        f.p.loadData = async () => new Promise(r => release = r);
        f.p.addTab = () => { };
        f.p.addIcons = () => { };
        f.p.addDock = () => ({});
        f.p.eventBus = { on: () => { } };
        let refreshes = 0;
        f.p.refreshConnection = async () => { refreshes++; };
        f.p.onload();
        f.p.selectedConnectionId = 'studio-default';
        f.p.confirmedConnectionId = 'studio-default';
        release({ bridgeUrl: config.bridgeUrl, bridgeToken: config.capabilityToken, hermesConnectionId: 'serve-local' });
        await tick();
        assert.equal(f.p.selectedConnectionId, 'studio-default');
        assert.equal(f.p.confirmedConnectionId, 'studio-default');
        assert.equal(refreshes, 0);
        f.p.observer?.disconnect();
    }
    finally {
        f.close();
    }
});
test('actual bundle healthy new-use service cannot certify an unread original legacy Chat', async () => {
    const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
    try {
        const old = { ...link('legacy-original'), adapter: 'studio', connectionId: 'studio-default', installId: null, legacyBridgeUrl: 'http://127.0.0.1:8784' };
        await f.p.workStore.linkChat(old);
        f.p.threads = [f.p.threadFromLink(old)];
        f.p.activeThreadId = old.chatId;
        f.p.connectionViews = [serve];
        f.p.updateConnectionUI(true);
        assert.notEqual(f.root.querySelector('[data-connection-label]')!.textContent, '已连接');
        const requests: string[] = [];
        globalThis.fetch = async (u) => { requests.push(String(u)); return Response.json({ data: [{ role: 'assistant', content: 'original legacy history' }] }); };
        await f.p.loadThreadMessages(f.p.threads[0]);
        f.p.updateConnectionUI(true);
        assert.equal(f.root.querySelector('[data-connection-label]')!.textContent, '已连接');
        assert.deepEqual(requests, ['http://127.0.0.1:8784/sessions/same-remote/messages']);
        assert.equal(f.p.threads[0].legacyBridgeUrl, old.legacyBridgeUrl);
    }
    finally {
        globalThis.fetch = originalFetch;
        f.close();
    }
});
test('actual bundle explicit offline preference survives another ready service and verified save', async () => { const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch; try {
    f.p.confirmedConnectionId = 'studio-default';
    f.p.selectedConnectionId = 'studio-default';
    const originalLoad = f.p.loadData.bind(f.p);
    const saved = { bridgeUrl: f.p.bridgeUrl, bridgeToken: f.p.bridgeToken, hermesConnectionId: 'studio-default', other: 'keep' };
    f.p.loadData = async (k: string) => k === 'settings' ? saved : originalLoad(k);
    let written: any;
    const save = f.p.saveData.bind(f.p);
    f.p.saveData = async (k: string, v: any) => { if (k === 'settings')
        written = v; return save(k, v); };
    const paths: string[] = [];
    globalThis.fetch = reads([serve, { ...studio, state: 'offline' }], paths);
    const result = await f.p.connectSettingsBridge({ url: f.p.bridgeUrl, token: '', detect: true });
    assert.equal(result.hermesReady, false);
    assert.equal(written.hermesConnectionId, 'studio-default');
    assert.equal(f.p.selectedConnectionId, 'studio-default');
    assert.equal(written.other, 'keep');
    assert.deepEqual(paths, ['/health', '/connections']);
}
finally {
    globalThis.fetch = originalFetch;
    f.close();
} });
test('actual bundle reload reads preference written by prior explicit detection', async () => { const originalFetch = globalThis.fetch; let saved: any; const first = await fixture({ confirmed: false }); try {
    globalThis.fetch = reads([studio]);
    await first.p.connectSettingsBridge({ url: first.p.bridgeUrl, token: '', detect: false });
    saved = structuredClone(await first.p.loadData('settings'));
    assert.equal(saved.hermesConnectionId, 'studio-default');
}
finally {
    globalThis.fetch = originalFetch;
    first.close();
} const reloaded = await fixture({ confirmed: false }); try {
    const load = reloaded.p.loadData.bind(reloaded.p);
    reloaded.p.loadData = async (k: string) => k === 'settings' ? saved : load(k);
    let seen = '';
    reloaded.p.refreshConnection = async () => { seen = reloaded.p.selectedConnectionId; };
    await reloaded.p.restoreConnectionSettings();
    assert.equal(seen, 'studio-default');
    assert.equal(reloaded.p.confirmedConnectionId, 'studio-default');
    assert.equal(reloaded.p.bridgeToken, saved.bridgeToken);
}
finally {
    reloaded.close();
} });
for (const settings of ['unreadable settings', [], { hermesConnectionId: 'http://private-address' }])
    test('actual bundle unknown saved settings are never overwritten by a candidate', async () => { const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch; try {
        globalThis.fetch = reads([studio]);
        f.p.loadData = async () => settings;
        let writes = 0;
        f.p.saveData = async () => { writes++; };
        const originalId = f.p.selectedConnectionId;
        await assert.rejects(f.p.connectSettingsBridge({ url: f.p.bridgeUrl, token: '', detect: false }), /格式错误|偏好已变化/);
        assert.equal(writes, 0);
        assert.equal(f.p.selectedConnectionId, originalId);
        assert.equal(f.input.value, '原 Chat 草稿');
    }
    finally {
        globalThis.fetch = originalFetch;
        f.close();
    } });

function cachedSettings(views: any[], connect?: (input: any) => Promise<any>) {
    const dom = new JSDOM('<body><button>设置</button></body>'), doc = dom.window.document;
    let saves = 0, selections = 0, inspections = 0;
    const dialog = new SettingsDialog(doc, {
        bridgeUrl: () => config.bridgeUrl, bridgeStatus: () => '连接暂不可用',
        save: async () => { saves++; }, connections: () => views,
        currentConnection: () => '', selectConnection: () => { selections++; },
        inspectBridge: async input => { inspections++; const result=await connect!(input); return result.bridgeAuthenticated&&Array.isArray(result.connections)?{...result,evidence:{checkedAt:'2026-10-22T12:00:00.000Z',code:'ok',reads:[{attempt:1,step:'health',httpStatus:200},{attempt:1,step:'connections',httpStatus:200}],companion:null}}:result; },
    });
    const source = doc.querySelector('button')!; source.focus(); dialog.open(source, 'hermes');
    return { dom, doc, dialog, source, counts: () => ({ saves, selections, inspections }),
        list: () => doc.querySelector<HTMLElement>('[data-hermes-results]')!,
        label: () => { const label = doc.querySelector<HTMLElement>('[data-hermes-results-label]'); assert.ok(label, 'result provenance must be visible'); return label; },
        detect: () => doc.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click(),
        close: () => { dialog.dispose(); dom.window.close(); } };
}
for (const [name, view, advice] of [
    ['Serve auth_missing', { ...serve, state: 'auth_missing' }, /缺少服务授权凭证/],
    ['Studio incompatible', { ...studio, state: 'incompatible' }, /缺少必要读取协议能力/],
    ['Studio ready', studio, /已通过认证与会话读取核验/],
    ['legacy ready', { ...studio, id: 'legacy-api', kind: 'legacy-api' }, /只可关联旧会话/],
] as const)
    test(`settings opening shows safe previous ${name} without inspecting or saving`, () => {
        const f = cachedSettings([{ ...view, displayName: '<img src="https://private.invalid">private-upstream', token: 'private-token', path: '/private-path' }]);
        try {
            assert.equal(f.list().hidden, false);
            assert.equal(f.list().children.length, 1);
            assert.match(f.list().textContent || '', advice);
            assert.equal(f.list().querySelector('img'), null);
            assert.doesNotMatch(f.doc.body.innerHTML, /private-upstream|private-token|private-path|private.invalid/);
            assert.match(f.label().textContent || '', /上次/);
            assert.match(f.label().textContent || '', /非实时|并非实时/);
            assert.match(f.label().textContent || '', /检查连接.*更新/);
            assert.doesNotMatch(f.label().textContent || '', /本次/);
            assert.deepEqual(f.counts(), { saves: 0, selections: 0, inspections: 0 });
            assert.equal(f.doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')!.value, '');
        } finally { f.close(); }
    });
test('settings opening without cached results keeps an undetected empty state', () => {
    const f = cachedSettings([]);
    try {
        assert.equal(f.list().hidden, true);
        assert.equal(f.list().children.length, 0);
        assert.match(f.label().textContent || '', /尚未|暂无/);
        assert.doesNotMatch(f.label().textContent || '', /已通过|本次/);
        assert.deepEqual(f.counts(), { saves: 0, selections: 0, inspections: 0 });
    } finally { f.close(); }
});
test('settings pane switches preserve previous results and unsaved candidate inputs', () => {
    const f = cachedSettings([serve, studio]);
    try {
        const token = f.doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!, url = f.doc.querySelector<HTMLInputElement>('[data-setting="baseUrl"]')!, select = f.doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')!;
        token.value = 'fictional-unsaved'; url.value = 'http://127.0.0.1:8789'; select.value = 'studio-default'; token.focus();
        f.doc.querySelector<HTMLButtonElement>('[data-settings-action="work"]')!.click();
        f.doc.querySelector<HTMLButtonElement>('[data-settings-action="hermes"]')!.click();
        assert.equal(token.value, 'fictional-unsaved'); assert.equal(url.value, 'http://127.0.0.1:8789'); assert.equal(select.value, 'studio-default');
        assert.equal(f.doc.activeElement, token);
        assert.equal(f.list().hidden, false); assert.match(f.label().textContent || '', /上次/);
        assert.deepEqual(f.counts(), { saves: 0, selections: 0, inspections: 0 });
    } finally { f.close(); }
});
test('explicit authenticated detection replaces previous results with safe current results', async () => {
    let input: any;
    const f = cachedSettings([{ ...studio, state: 'incompatible' }], async received => {
        input = received; return { url: config.bridgeUrl, message: 'Bridge 已配对', bridgeAuthenticated: true, hermesReady: true, connections: [{ ...studio, displayName: '<img src=x>private-upstream', token: 'private-token', path: '/private-path' }] };
    });
    try {
        const select = f.doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')!; select.value = 'studio-default';
        f.detect(); await tick();
        assert.equal(input.connectionId, 'studio-default');
        assert.equal(f.list().children.length, 1); assert.match(f.list().textContent || '', /已通过认证与会话读取核验/);
        assert.doesNotMatch(f.list().textContent || '', /缺少必要/);
        assert.match(f.label().textContent || '', /本次/); assert.doesNotMatch(f.label().textContent || '', /上次/);
        assert.doesNotMatch(f.doc.body.innerHTML, /private-upstream|private-token|private-path|<img/);
        assert.equal(select.value, 'studio-default');
        assert.deepEqual(f.counts(), { saves: 0, selections: 0, inspections: 1 });
    } finally { f.close(); }
});
for (const failure of ['reject', 'unauthenticated-with-connections', 'no-connections'] as const)
    test(`retry ${failure} keeps missing response unknown and preserves candidate inputs`, async () => {
        let attempts = 0;
        const f = cachedSettings([serve, studio], async () => {
            if (++attempts === 1) return { url: config.bridgeUrl, message: 'Bridge 已配对', bridgeAuthenticated: true, hermesReady: true, connections: [serve, studio] };
            if (failure === 'reject') throw Error('fictional retry failed');
            return { url: config.bridgeUrl, message: '本次核对未取得服务状态', bridgeAuthenticated: failure === 'no-connections', hermesReady: false, ...(failure === 'unauthenticated-with-connections' ? { connections: [{ ...studio, state: 'offline' }] } : {}) };
        });
        try {
            f.detect(); await tick(); assert.match(f.label().textContent || '', /本次/);
            const token = f.doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!, select = f.doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')!;
            token.value = 'fictional-unsaved'; select.value = 'studio-default';
            f.detect();
            assert.match(f.label().textContent || '', /上次/);
            assert.doesNotMatch(f.label().textContent || '', /本次/);
            await tick();
            assert.equal(f.list().children.length,0); assert.equal(f.list().hidden,true);
            assert.match(f.label().textContent || '', /尚未|未知/); assert.doesNotMatch(f.label().textContent || '', /本次/);
            assert.equal(token.value, 'fictional-unsaved'); assert.equal(select.value, 'studio-default');
            assert.equal(f.counts().selections, 0);
            if (failure === 'reject') {assert.match(f.doc.querySelector('[data-settings-error]')!.textContent || '', /连接操作未完成/);assert.doesNotMatch(f.doc.body.textContent||'',/fictional retry failed/);}
        } finally { f.close(); }
    });
test('authenticated empty detection removes previous rows without inventing a service result', async () => {
    const f = cachedSettings([studio], async () => ({ url: config.bridgeUrl, message: '未找到服务', bridgeAuthenticated: true, hermesReady: false, connections: [] }));
    try {
        f.detect(); await tick();
        assert.equal(f.list().hidden, true); assert.equal(f.list().children.length, 0);
        assert.match(f.label().textContent || '', /本次.*未找到|本次.*未发现/);
        assert.doesNotMatch(f.label().textContent || '', /已通过/);
    } finally { f.close(); }
});
test('late explicit detection cannot replace a reopened dialog and retains busy close guards', async () => {
    let release!: (result: any) => void;
    const f = cachedSettings([{ ...studio, state: 'incompatible' }], async () => new Promise(r => release = r));
    try {
        f.detect();
        assert.equal(f.doc.querySelector<HTMLButtonElement>('[data-settings-action="close"]')!.disabled, true);
        f.dialog.close(); assert.ok(f.doc.querySelector('.sac-settings-overlay'));
        f.dialog.dispose(); f.dialog.open(f.source, 'hermes');
        release({ url: config.bridgeUrl, message: 'Bridge 已配对', bridgeAuthenticated: true, hermesReady: true, connections: [studio] }); await tick();
        assert.match(f.list().textContent || '', /缺少必要读取协议能力/);
        assert.match(f.label().textContent || '', /上次/); assert.doesNotMatch(f.label().textContent || '', /本次/);
        assert.equal(f.doc.querySelector('.sac-settings-overlay')!.hasAttribute('aria-busy'), false);
        f.dialog.close(); assert.equal(f.doc.activeElement, f.source);
    } finally { f.close(); }
});
test('actual plugin settings entry shows previous states without requests and explicit update preserves original identity', async () => {
    const f = await fixture({ confirmed: false }), originalFetch = globalThis.fetch;
    try {
        const old = link('cached-original-chat'); await f.p.workStore.linkChat(old);
        await f.p.workStore.saveResume({ workId: W, documentId: W, focusBlockId: null, chatId: old.chatId, taskId: null, updatedAt: '2026-10-10' });
        await f.p.workStore.setPending({ id: 'cached-unknown', kind: 'chat', workId: W, state: 'unknown', details: 'fictional queued', updatedAt: '2026-10-10' });
        f.p.threads = [f.p.threadFromLink(old)]; f.p.activeThreadId = old.chatId; f.p.activateDraft();
        f.input.value = 'cached original draft'; f.input.dispatchEvent(new f.dom.window.Event('input'));
        const thread = structuredClone(f.p.threads[0]), resume = await f.p.workStore.getResume(W), pending = await f.p.workStore.listPending();
        f.p.connectionViews = [{ ...serve, state: 'auth_missing' }, { ...studio, state: 'incompatible' }, { ...studio, id: 'legacy-api', kind: 'legacy-api' }];
        f.p.workHost.listNotebooks = async () => [];
        const paths: string[] = []; globalThis.fetch = reads([studio], paths);
        let writes = 0; const save = f.p.saveData.bind(f.p); f.p.saveData = async (k: string, v: any) => { writes++; return save(k, v); };
        f.p.openSettings(f.root, 'hermes'); await tick();
        const list = f.doc.querySelector<HTMLElement>('[data-hermes-results]')!, label = f.doc.querySelector<HTMLElement>('[data-hermes-results-label]')!;
        assert.equal(list.hidden, false); assert.equal(list.children.length, 3); assert.match(label.textContent || '', /上次/);
        assert.deepEqual(paths, []); assert.equal(writes, 0); assert.equal(f.p.confirmedConnectionId, undefined);
        const select = f.doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')!; select.value = 'studio-default';
        f.doc.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click(); await tick();
        assert.match(label.textContent || '', /本次/); assert.equal(list.children.length, 1);
        assert.deepEqual(paths, ['/health', '/connections']); assert.equal(writes, 0);
        assert.equal(f.p.confirmedConnectionId, undefined);
        f.doc.querySelector<HTMLButtonElement>('[data-settings-action="confirm-bridge"]')!.click(); await tick();
        assert.equal(writes, 1); assert.deepEqual(paths, ['/health', '/connections', '/health', '/connections']);
        assert.equal(f.p.selectedConnectionId, 'studio-default');
        assert.equal(f.p.activeThreadId, old.chatId); assert.deepEqual(f.p.threads[0], thread);
        assert.equal(f.input.value, 'cached original draft');
        assert.deepEqual(await f.p.workStore.getResume(W), resume); assert.deepEqual(await f.p.workStore.listPending(), pending);
    } finally { globalThis.fetch = originalFetch; f.p.settingsDialog?.dispose(); f.close(); }
});

test('inspection reports safe fixed evidence for old new and damaged companion metadata',async()=>{
 const {connectionAdvice}=await import('../src/work/connection-settings.ts');
 for(const meta of [undefined,{schemaVersion:2},{schemaVersion:1,bridgeVersion:'0.3.9',capabilities:['hermes-connection-inspection-v1']}]){
  const result=await inspectLocalBridge(config,async u=>Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:[{...studio,state:'auth_failed'}],meta}));
  assert.equal(result.bridgeAuthenticated,true);assert.equal(result.hermesReady,false);assert.equal(result.evidence?.code,'ok');assert.equal(result.saveOutcome,'not-requested');assert.ok(Number.isFinite(Date.parse(result.evidence!.checkedAt)));
  assert.deepEqual(result.evidence?.reads,[{attempt:1,step:'health',httpStatus:200},{attempt:1,step:'connections',httpStatus:200}]);
  assert.equal(result.evidence?.companion?.bridgeVersion??null,meta?.schemaVersion===1?'0.3.9':null);
 }
 assert.equal(connectionAdvice({...studio,state:'auth_failed'} as any),'原服务拒绝了授权，请核对原服务的授权设置');
});
test('inspection fixed evidence distinguishes pairing HTTP body and incomplete failures',async()=>{
 const cases=[{token:'',status:200,body:{data:[studio]},code:'pairing_required'}, {status:401,body:null,code:'pairing_rejected'},{status:403,body:{data:[studio]},code:'pairing_rejected'},{status:503,body:{data:[studio]},code:'connections_http_error'},{status:200,body:{data:[{...studio,profile:''}]},code:'connections_invalid'},{status:200,body:null,code:'connections_invalid'}];
 for(const value of cases){
  const result=await inspectLocalBridge({...config,capabilityToken:value.token??config.capabilityToken},async u=>String(u).endsWith('/health')?Response.json({ok:true,service:'siyuan-ai-collab-bridge'}):new Response(value.body===null?'invalid':JSON.stringify(value.body),{status:value.status}));
  assert.equal(result.evidence?.code,value.code);assert.equal(result.bridgeAuthenticated,false);assert.equal(result.hermesReady,false);
  assert.equal(result.evidence?.reads.length,value.token===''?1:2);
  if(value.token!=='')assert.equal(result.evidence?.reads[1].httpStatus,value.status);
 }
 const result=await inspectLocalBridge(config,async u=>{if(String(u).endsWith('/health'))return Response.json({ok:true,service:'siyuan-ai-collab-bridge'});throw Error('fictional-token private-path');});
 assert.equal(result.evidence?.code,'read_incomplete');assert.equal(result.evidence?.reads[1].httpStatus,null);assert.doesNotMatch(JSON.stringify(result),/private-path/);
});
test('inspection errors retain fixed evidence without address or raw error text',async()=>{
 const {BridgeInspectionError}=await import('../src/work/connection-settings.ts');
 for(const [bridgeUrl,fetcher,code,status] of [ ['http://private-path',async()=>{throw Error('fictional-token');},'invalid_address',undefined], [config.bridgeUrl,async()=>{throw Error('fictional-token private-path');},'health_unreachable',null], [config.bridgeUrl,async()=>Response.json({ok:true,service:'other',private:'fictional-token'},{status:503}),'health_invalid',503], [config.bridgeUrl,async()=>new Response('invalid'),'health_invalid',200]] as const){
  await assert.rejects(()=>inspectLocalBridge({...config,bridgeUrl},fetcher as typeof fetch),(error:any)=>{assert.ok(error instanceof BridgeInspectionError);assert.equal(error.evidence.code,code);assert.equal(error.evidence.reads[0]?.httpStatus,status);assert.doesNotMatch(error.message,/fictional-token|private-path|127\.0\.0\.1/);return true;});
 }
});
test('detection aggregates actual attempts and preserves finite fallback preference',async()=>{
 const {detectLocalBridge,BridgeInspectionError}=await import('../src/work/connection-settings.ts');
 const paths:string[]=[];
 const fetcher:typeof fetch=async(u,i)=>{paths.push(String(u));if(new URL(String(u)).port==='8789')throw Error('private-path');return reads([studio])(u,i);};
 const result=await detectLocalBridge({...config,bridgeUrl:'http://127.0.0.1:8789'},fetcher);
 assert.deepEqual(result.evidence?.reads,[{attempt:1,step:'health',httpStatus:null},{attempt:2,step:'health',httpStatus:200},{attempt:2,step:'connections',httpStatus:200}]);assert.equal(paths.length,3);
 await assert.rejects(()=>detectLocalBridge({...config,bridgeUrl:'http://127.0.0.1:8789'},async()=>{throw Error('private-path');}),(error:any)=>{assert.ok(error instanceof BridgeInspectionError);assert.deepEqual(error.evidence.reads,[{attempt:1,step:'health',httpStatus:null},{attempt:2,step:'health',httpStatus:null}]);return true;});
 const first=await detectLocalBridge({...config,bridgeUrl:'http://127.0.0.1:8789'},async(u,i)=>new URL(String(u)).port==='8789'?reads([studio],[],401)(u,i):Response.json({bad:true}));
 assert.equal(first.evidence?.code,'pairing_rejected');assert.equal(first.evidence?.reads.length,3);assert.equal(first.bridgeAuthenticated,false);
});

test('timed out inspection evidence cannot be rewritten by late noncooperative fetch headers',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let release!:(response:Response)=>void,started=false;
 const checking=inspectLocalBridge(config,async u=>String(u).endsWith('/health')?Response.json({ok:true,service:'siyuan-ai-collab-bridge'}):new Promise<Response>(resolve=>{started=true;release=resolve;}));
 for(let i=0;i<20&&!started;i++)await Promise.resolve();
 assert.equal(started,true);t.mock.timers.tick(10000);
 const result=await checking;
 assert.equal(result.evidence?.code,'read_incomplete');assert.equal(result.evidence?.reads[1].httpStatus,null);
 release(Response.json({data:[studio]}));for(let i=0;i<12;i++)await Promise.resolve();
 assert.equal(result.evidence?.reads[1].httpStatus,null);
});
