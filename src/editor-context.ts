import type { ContextInput, ContextBlock } from './core.ts';
import { parseKramdownResponse } from './core.ts';

type EditorContextOptions = { document: Document; activeProtyle?: Element | null; rootID?: string; recentBlockIds?: string[] };
export type KramdownFetcher = (blockId: string) => Promise<unknown>;
export type EditorLike = { protyle?: { element?: Element | null; block?: { rootID?: string } } };

type EditorSelectionOptions = { document: Document; editors: readonly EditorLike[] };

function editorElement(editor: EditorLike): Element | null {
  const element = editor.protyle?.element;
  return element && element.nodeType === 1 ? element : null;
}

function isVisible(element: Element): boolean {
  const html = element as HTMLElement;
  return !html.hidden && element.getAttribute('aria-hidden') !== 'true' &&
    html.style.display !== 'none' && html.style.visibility !== 'hidden';
}

function editorAtTarget(editors: readonly EditorLike[], target: Node | null): EditorLike | undefined {
  if (!target) return undefined;
  return editors.find(editor => {
    const element = editorElement(editor);
    return Boolean(element && element.matches('.protyle') && element.ownerDocument.documentElement.contains(element) && element.contains(target));
  });
}

export function selectActiveEditor({ document, editors }: EditorSelectionOptions): EditorLike | undefined {
  const recognizable = editors.filter(editor => {
    const element = editorElement(editor);
    return Boolean(element && element.matches('.protyle') && document.documentElement.contains(element));
  });
  if (!recognizable.length) return undefined;

  const selection = document.defaultView?.getSelection?.();
  const selected = editorAtTarget(recognizable, selection?.anchorNode || null) || editorAtTarget(recognizable, selection?.focusNode || null);
  if (selected) return selected;

  const focused = editorAtTarget(recognizable, document.activeElement);
  if (focused) return focused;

  const active = recognizable.find(editor => {
    const element = editorElement(editor);
    return Boolean(element && element.classList.contains('protyle--active') && isVisible(element));
  });
  if (active) return active;

  const visible = recognizable.filter(editor => isVisible(editorElement(editor)!));
  return visible[0] || (recognizable.length === 1 ? recognizable[0] : undefined);
}

function textOf(block: Element): string { const editable = block.querySelector('[contenteditable="true"]'); return (editable?.textContent || block.textContent || '').trim(); }

export function readEditorDocumentTitle(activeProtyle?:Element|null):string {
  const title=activeProtyle?.querySelector('.protyle-title__input');
  const value=(title as HTMLInputElement|null)?.value;
  return (typeof value==='string'?value:title?.textContent||'').trim();
}

export function extractEditorContext(options: EditorContextOptions): ContextInput & { degraded: boolean } {
  const { document, activeProtyle, rootID = '', recentBlockIds = [] } = options;
  if (!activeProtyle) return { documentId:'', title:'', focusBlockId:'', selection:'', nearby:[], recent:[], degraded:true };
  const selection = document.defaultView?.getSelection?.();
  const anchor = selection?.anchorNode;
  const inside = Boolean(anchor && activeProtyle.contains(anchor));
  const ElementCtor = activeProtyle.ownerDocument.defaultView?.Element;
  const focus = inside ? (ElementCtor && anchor instanceof ElementCtor ? anchor : anchor?.parentElement)?.closest('[data-node-id]') : null;
  const content = activeProtyle.querySelector('.protyle-wysiwyg') || activeProtyle;
  const blocks = [...content.querySelectorAll<HTMLElement>('[data-node-id]')];
  const index = focus ? blocks.indexOf(focus as HTMLElement) : -1;
  const nearbyBlocks = index >= 0 ? blocks.slice(Math.max(0,index-2), index+3) : [];
  const nearby: ContextBlock[] = nearbyBlocks.map(block => ({ blockId:block.dataset.nodeId || '', text:textOf(block) }));
  const title = readEditorDocumentTitle(activeProtyle);
  const recent = recentBlockIds.map(id => nearby.find(block => block.blockId === id)).filter((block): block is ContextBlock => Boolean(block));
  return { documentId:rootID || activeProtyle.getAttribute('data-id') || '', title, focusBlockId:focus?.getAttribute('data-node-id') || '', selection:inside ? (selection?.toString() || '') : '', nearby, recent, degraded:recent.length === 0 };
}

export async function enrichEditorContext(input: ContextInput, fetchKramdown: KramdownFetcher): Promise<ContextInput> {
  const enrich = async (block: ContextBlock): Promise<ContextBlock> => {
    const sourceMarkdown = parseKramdownResponse(await fetchKramdown(block.blockId));
    return { ...block, sourceMarkdown, expectedOriginal: sourceMarkdown };
  };
  return { ...input, nearby: await Promise.all(input.nearby.slice(0,5).map(enrich)), recent: await Promise.all(input.recent.filter(x => input.nearby.some(y => y.blockId === x.blockId)).slice(0,5).map(enrich)) };
}
