import type { Plugin, openTab as sdkOpenTab } from 'siyuan';
import type { WorkPage, WorkPageContext, WorkPageRoute } from './page.ts';

/** Register during onload, before settings or other asynchronous work. */
export class WorkNativeTab {
  private page?: WorkPage;
  private element?: HTMLElement;
  private route: WorkPageRoute = {kind:'home'};
  private context: WorkPageContext | null = null;
  private disposed = false;
  constructor(private readonly plugin: Pick<Plugin,'name'|'app'|'addTab'>, private readonly openTab: typeof sdkOpenTab,
    private readonly mount: (element: HTMLElement, context: WorkPageContext | null) => WorkPage) {
    const owner=this;
    plugin.addTab({type:'ai-work-home',init:function(this:{element:HTMLElement}) {
      if(owner.disposed)return;
      owner.page?.dispose(); owner.element=this.element;
      owner.page=owner.mount(this.element,owner.context);owner.page.show(owner.route);void owner.page.refresh();
    },destroy:function(this:{element:HTMLElement}) {
      if(owner.element!==this.element)return;
      owner.page?.dispose();owner.page=undefined;owner.element=undefined;
    }});
  }
  async open(route: WorkPageRoute, context: WorkPageContext | null): Promise<void> {
    if(this.disposed)return;
    this.route=route;this.context=context;
    const existing=this.page;
    existing?.setContext(context);existing?.show(route);
    await this.openTab({app:this.plugin.app,custom:{id:this.plugin.name+'ai-work-home',title:'AI Work',icon:'iconSiyuanAICollab'},openNewTab:false});
    if(existing)void existing.refresh();
  }
  refresh(): void { if(!this.disposed)void this.page?.refresh(); }
  dispose(): void {this.disposed=true;this.page?.dispose();this.page=undefined;this.element=undefined;}
}
