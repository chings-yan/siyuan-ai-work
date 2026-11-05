export type StudioPickerSession = { id: string; title?: string; preview?: string; [key: string]: unknown };
export function mountStudioPicker(root: HTMLElement, overlay: HTMLElement): void {
  const anchor = root.querySelector<HTMLElement>('[data-chat-menu-anchor]');
  if (!anchor) throw new Error('思源 AI 对话菜单不可用');
  anchor.appendChild(overlay);
}
export function filterStudioSessions(sessions: StudioPickerSession[], query: string): StudioPickerSession[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...sessions];
  return sessions.filter(session => `${session.title ?? ''}\n${session.preview ?? ''}\n${session.id}`.toLocaleLowerCase().includes(needle));
}
export function renderStudioSessionOptions(sessions: StudioPickerSession[], query: string): string {
  const visible = filterStudioSessions(sessions, query);
  return visible.map(session => {
    const title = session.title || session.id;
    const escapedId = escapeStudioHtml(session.id);
    const escapedTitle = escapeStudioHtml(title);
    return `<label><input type="radio" name="studio-session" value="${escapedId}"><span title="${escapedTitle}">${escapedTitle}</span></label>`;
  }).join('') || '<div class="sac-mention-empty" role="status">没有匹配的对话</div>';
}

function escapeStudioHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

export function createStudioPickerState(deps: {
  list: () => Promise<StudioPickerSession[]>;
  bind: (id: string) => Promise<unknown>;
  load: (id: string) => Promise<unknown>;
}) {
  let sessions: StudioPickerSession[] = [];
  let selected: string | null = null;
  let open = false;
  return {
    get sessions() { return sessions; },
    get selected() { return selected; },
    get isOpen() { return open; },
    async open() { sessions = await deps.list(); selected = null; open = true; },
    select(id: string) { if (sessions.some(session => session.id === id)) selected = id; },
    cancel() { selected = null; open = false; },
    async confirm() { if (!selected) return; const id = selected; await deps.bind(id); await deps.load(id); open = false; },
  };
}
