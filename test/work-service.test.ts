import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkService, type WorkHost } from '../src/work/service.ts';
import { WorkStore } from '../src/work/store.ts';

const root = '20260923140000-abcdef0';
const external = '20260923140001-abcdef0';

test('external-document link checks its scene after async validation and inside the serialized queue',async()=>{
 const f=fixture();await f.service.createFromDocument({documentId:root,goal:'目标',approved:true});let current=true;
 const title=f.host.getDocumentTitle;f.host.getDocumentTitle=async(id:string)=>{if(id===external)current=false;return title(id);};
 await assert.rejects((f.service.linkExternalDocument as any)(root,external,true,()=>{if(!current)throw Error('文档已变化');}),/变化/);assert.deepEqual(await f.service.listExternalDocuments(root),[]);
 f.host.getDocumentTitle=title;await assert.rejects((f.service.linkExternalDocument as any)(root,external,true,()=>{throw Error('排队期间已离开');}),/离开/);assert.deepEqual(await f.service.listExternalDocuments(root),[]);
});
test('external-document final target validation rejects changed metadata before appending',async()=>{
 const f=fixture();await f.service.createFromDocument({documentId:root,goal:'目标',approved:true});
 await assert.rejects((f.service.linkExternalDocument as any)(root,external,true,()=>{},async()=>{throw Error('所选 Work 已变化');}),/Work 已变化/);
 assert.deepEqual(await f.service.listExternalDocuments(root),[]);
});

test('状态操作仅在明确确认且目标状态仍相符时写入，保留文档块及关联',async()=>{
  const f=fixture();f.attrs.set(root,{'custom-ai-work-v0':'1','custom-ai-work-status':'active'});f.children.set(root,['original-block']);
  await f.store.registerWork(root);await f.store.linkTask({workId:root,taskId:'task',connectionId:'siyuan-native-local'});
  await assert.rejects(f.service.setStatus(root,'completed',false),/确认/);
  await assert.rejects((f.service.setStatus as any)(root,'completed',true,{expectedStatus:'paused'}),/状态已变化/);
  await assert.rejects((f.service.setStatus as any)(root,'completed',true,{isCurrent:()=>false}),/页面|状态已变化/);
  assert.equal((await f.service.readWork(root))?.status,'active');
  await (f.service.setStatus as any)(root,'completed',true,{expectedStatus:'active',isCurrent:()=>true});
  assert.equal((await f.service.readWork(root))?.status,'completed');assert.deepEqual(f.children.get(root),['original-block']);assert.equal((await f.store.listTasks(root)).length,1);
  await f.service.setStatus(root,'active',true);assert.equal((await f.service.readWork(root))?.status,'active');
});

test('状态核对等待期间离开页面不写入，写入未能读回时明确报错',async()=>{
  const f=fixture();f.attrs.set(root,{'custom-ai-work-v0':'1','custom-ai-work-status':'active'});
  let current=true,writes=0;const title=f.host.getDocumentTitle;
  f.host.getDocumentTitle=async id=>{current=false;return title(id);};
  f.host.setAttrs=async()=>{writes++;};
  await assert.rejects((f.service.setStatus as any)(root,'completed',true,{isCurrent:()=>current}),/页面|状态已变化/);assert.equal(writes,0);
  f.host.getDocumentTitle=title;await assert.rejects(f.service.setStatus(root,'completed',true),/读回/);assert.equal(writes,1);
});

test('未知的非空 Work 状态需人工核对，不能被默认状态覆盖',async()=>{
  const f=fixture();f.attrs.set(root,{'custom-ai-work-v0':'1','custom-ai-work-status':'archived'});
  await assert.rejects(f.service.readWork(root),/状态.*未知|状态.*核对/);
  await assert.rejects(f.service.setStatus(root,'paused',true,{expectedStatus:'active'}),/状态.*未知|状态.*核对/);
  assert.equal(f.attrs.get(root)?.['custom-ai-work-status'],'archived');
  f.attrs.set(root,{'custom-ai-work-v0':'1'});
  assert.equal((await f.service.readWork(root))?.status,'active');
});
function fixture() {
  const attrs = new Map<string, Record<string, string>>();
  const children = new Map<string, string[]>();
  const markdown = new Map<string, string>();
  let next = 0;
  const disk = new Map<string, unknown>();
  const host: WorkHost = {
    getAttrs: async id => attrs.get(id) ?? {},
    setAttrs: async (id, value) => { attrs.set(id, { ...(attrs.get(id) ?? {}), ...value }); },
    getChildren: async id => children.get(id) ?? [],
    getBlockMarkdown: async id => markdown.get(id) ?? '',
    prependMarkdown: async (parentId, text) => {
      await host.appendMarkdown(parentId,text);const ids=children.get(parentId)!;children.set(parentId,[ids.at(-1)!,...ids.slice(0,-1)]);
    },
    appendMarkdown: async (parentId, text) => {
      const id = `block-${++next}`;
      children.set(parentId, [...(children.get(parentId) ?? []), id]);
      markdown.set(id, text);
      const role = text.match(/custom-ai-work-role="([^"]+)"/)?.[1];
      const doc = text.match(/custom-ai-work-document-id="([^"]+)"/)?.[1];
      attrs.set(id, { ...(role ? { 'custom-ai-work-role': role } : {}), ...(doc ? { 'custom-ai-work-document-id': doc } : {}) });
    },
    getDocumentPath: async id => id === root ? `/${root}.sy` : `/${external}.sy`,
    getDocumentTitle: async id => id === root ? '既有工作文档' : '外部资料',
  };
  const store = new WorkStore({ loadData: async key => disk.get(key), saveData: async (key, value) => { disk.set(key, structuredClone(value)); } });
  return { host, store, attrs, children, markdown, service: new WorkService(host, store) };
}

test('原地创建 Work 不重建旧块，失败后复用已有 Goal', async () => {
  const f = fixture();
  f.children.set(root, ['old-block']);
  await assert.rejects(f.service.createFromDocument({ documentId: root, goal: '推进验收', approved: false }), /确认/);
  assert.deepEqual(f.children.get(root), ['old-block']);
  const work = await f.service.createFromDocument({ documentId: root, goal: '推进验收', approved: true });
  assert.equal(work.id, root);
  assert.equal(f.attrs.get(root)?.['custom-ai-work-v0'], '1');
  assert.equal(f.children.get(root)?.filter(id => id === 'old-block').length, 1);
  await f.service.createFromDocument({ documentId: root, goal: '推进验收', approved: true });
  assert.equal(f.children.get(root)?.length, 2);
  assert.deepEqual(await f.store.listWorks(), [root]);
  f.markdown.set(f.children.get(root)![0], '**目标**：用户后来修改的目标\n{: custom-ai-work-role="goal"}');
  assert.equal((await f.service.readWork(root))?.goal, '用户后来修改的目标');
});

test('只有明确关联的外部文档进入 Work 资料，重复点击不重复创建引用', async () => {
  const f = fixture();
  await f.service.createFromDocument({ documentId: root, goal: '推进验收', approved: true });
  await f.service.linkExternalDocument(root, external, true);
  await f.service.linkExternalDocument(root, external, true);
  assert.deepEqual(await f.service.listExternalDocuments(root), [external]);
  assert.equal(f.children.get(root)?.length, 2);
  assert.match([...f.markdown.values()].at(-1) ?? '', /\(\(20260923140001-abcdef0/);
});
