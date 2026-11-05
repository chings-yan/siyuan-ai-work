export type NavigationScene = { currentWorkId: string | null; busy: boolean; pendingWrite: boolean };
export type NavigationDecision = { kind: 'keep'; workId: string | null; navigateEditor: false } | { kind: 'switch'; workId: string; navigateEditor: false } | { kind: 'choose'; workIds: string[]; navigateEditor: false };

export function resolveCandidates(documentPath: string, workIds: string[], external: { workId: string; documentId: string }[], documentId = ''): string[] {
  const parts = documentPath.split('/').filter(Boolean).map(x => x.replace(/\.sy$/, ''));
  const result = new Set(workIds.filter(id => parts.includes(id)));
  for (const link of external) if (link.documentId === documentId && workIds.includes(link.workId)) result.add(link.workId);
  return [...result];
}

export function decideNavigation(scene: NavigationScene, candidates: string[]): NavigationDecision {
  if (scene.busy || scene.pendingWrite || scene.currentWorkId && candidates.includes(scene.currentWorkId)) return { kind: 'keep', workId: scene.currentWorkId, navigateEditor: false };
  if (candidates.length === 1) return { kind: 'switch', workId: candidates[0], navigateEditor: false };
  if (candidates.length > 1) return { kind: 'choose', workIds: [...candidates], navigateEditor: false };
  return { kind: 'keep', workId: scene.currentWorkId, navigateEditor: false };
}
