import { bindDismissibleMenu } from './dismissible-menu.ts';
import { documentLinkName, documentLinkConfirmation } from './document-link.ts';
type QuickWork = { id: string; title: string; goal: string; status: string; error?: string };
type CurrentDocument = { id: string; title: string };
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

/** The dock selector stays in place. Entering a Work and linking the open document are separate operations. */
export class WorkQuickPicker {
  private readonly button: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private rows: QuickWork[] = [];
  private captured: CurrentDocument | null = null;
  private version = 0;
  private busy = false;
  private disposed = false;
  private readonly dismiss:()=>void;
  constructor(private readonly root: HTMLElement, private readonly options: {
    load(): Promise<QuickWork[]>;
    currentDocument(): CurrentDocument | null;
    currentWork(): string | null;
    enter(id: string): Promise<void>;
    link(id: string, document: CurrentDocument): Promise<void>;
    create(): Promise<void>;
    browse(): void;
    status(message: string): void;
    confirm(message: string): boolean;
  }) {
    this.button=root.querySelector<HTMLButtonElement>('[data-action="work-picker"]')!;
    this.menu=root.querySelector<HTMLElement>('[data-work-quick-menu]')!;
    this.button.addEventListener('click',this.toggle);
    this.menu.addEventListener('click',this.click);
    this.menu.addEventListener('input',this.search);
    this.dismiss=bindDismissibleMenu(root.querySelector('[data-work-quick-anchor]'),this.menu,this.button,()=>this.close());
  }
  dispose(): void {
    this.disposed=true;this.version++;
    this.button.removeEventListener('click',this.toggle);
    this.menu.removeEventListener('click',this.click);
    this.menu.removeEventListener('input',this.search);
    this.dismiss();
  }
  private close(): void {this.version++;this.menu.hidden=true;this.button.setAttribute('aria-expanded','false');}
  private toggle = (): void => {if(this.menu.hidden)void this.open();else this.close();};
  private async open(): Promise<void> {
    const version=++this.version;this.captured=this.options.currentDocument();this.menu.hidden=false;this.button.setAttribute('aria-expanded','true');
    this.menu.innerHTML='<p role="status">正在读取 Work…</p>';
    try { const rows=await this.options.load();if(this.disposed||version!==this.version)return;this.rows=rows;this.render('');this.menu.querySelector<HTMLInputElement>('[data-quick-search]')?.focus(); }
    catch(error) {if(this.disposed||version!==this.version)return;this.menu.innerHTML=`<p role="alert">Work 列表读取失败：${esc(error instanceof Error?error.message:String(error))}</p><button type="button" data-quick-action="retry">重试</button>`;}
  }
  private render(query: string): void {
    this.menu.innerHTML=`<label>查找 Work<input data-quick-search aria-label="查找 Work" placeholder="搜索名称或目标" value="${esc(query)}"></label><p class="sac-quick-context">${this.captured?`当前文档：${esc(documentLinkName(this.captured))}。选择下方 Work 后可关联这篇文档。`:'没有打开可关联的文档。'}</p><div class="sac-quick-results">${this.results(query)}</div><div class="sac-quick-footer"><button type="button" data-quick-action="create">＋ 新建 Work</button><button type="button" data-quick-action="browse">打开 Work 主页</button></div>`;
  }
  private results(query:string):string {
    const items=this.rows.filter(row=>`${row.title} ${row.goal}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
    return items.map(row=>`<div class="sac-quick-row"><strong>${esc(row.title)}${this.options.currentWork()===row.id?' · 当前':''}</strong><small>${esc(row.goal||'未设置目标')}</small>${row.error?`<small role="alert">${esc(row.error)}</small>`:`<div><button type="button" data-quick-action="enter" data-work-id="${esc(row.id)}">进入 Work</button>${this.captured&&this.captured.id!==row.id?`<button type="button" data-quick-action="link" data-work-id="${esc(row.id)}">关联当前文档</button>`:''}</div>`}</div>`).join('')||'<p>没有符合条件的 Work</p>';
  }
  private search = (event: Event): void => {
    const target=event.target as HTMLInputElement;if(!target.matches('[data-quick-search]'))return;
    const list=this.menu.querySelector<HTMLElement>('.sac-quick-results');if(list)list.innerHTML=this.results(target.value);
  };
  private click = (event: Event): void => {
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-quick-action]');if(!button||this.busy)return;
    const action=button.dataset.quickAction,id=button.dataset.workId||'';
    if(action==='retry'){void this.open();return;}
    if(action==='browse'){this.close();this.options.browse();return;}
    if(action==='create'){this.close();void this.options.create().catch(e=>this.options.status(e instanceof Error?e.message:String(e)));return;}
    const row=this.rows.find(row=>row.id===id&&!row.error);if(!row)return;
    this.busy=true;
    void (async()=>{
      try {
        if(action==='enter'){await this.options.enter(id);this.close();}
        else if(action==='link'){
          const doc=this.captured;
          if(!doc||this.options.currentDocument()?.id!==doc.id)throw new Error('当前文档已变化，请重新打开 Work 列表关联');
          if(!this.options.confirm(documentLinkConfirmation(doc,row)))return;
          if(this.options.currentDocument()?.id!==doc.id)throw new Error('当前文档已变化，请重新核对关联目标');
          await this.options.link(id,doc);this.options.status(`“${documentLinkName(doc)}”已关联到“${row.title}”；当前文档和对话保持不变`);this.close();
        }
      }catch(e){this.options.status(e instanceof Error?e.message:String(e));}
      finally{this.busy=false;}
    })();
  };
}
