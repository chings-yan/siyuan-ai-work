import type { Plugin, openTab as sdkOpenTab } from 'siyuan';
import { isWorkPageVisible, type WorkPage, type WorkPageContext, type WorkPageRoute } from './page.ts';

/** Register during onload, before settings or other asynchronous work. */
export class WorkNativeTab {
  private page?: WorkPage;
  private element?: HTMLElement;
  private route: WorkPageRoute = {kind:'home'};
  private context: WorkPageContext | null = null;
  private disposed = false;
  private queued?:object;
  private visibilityObserver?:MutationObserver;
  private wasVisible=false;
  private tasksInvalidated=false;
  private eventsBound=false;
  private readonly eventWindow=globalThis.window;
  private readonly eventDocument=globalThis.document;
  private readonly invalidate=()=>this.refreshTasks();
  constructor(private readonly plugin: Pick<Plugin,'name'|'app'|'addTab'>, private readonly openTab: typeof sdkOpenTab,
    private readonly mount: (element: HTMLElement, context: WorkPageContext | null) => WorkPage) {
    const owner=this;
    plugin.addTab({type:'ai-work-home',init:function(this:{element:HTMLElement}) {
      if(owner.disposed)return;
      owner.bindEvents();
      owner.stopObserving();
      owner.page?.dispose(); owner.element=this.element;
      owner.page=owner.mount(this.element,owner.context);owner.page.show(owner.route);void owner.page.refresh();
      owner.observeVisibility(this.element);
    },destroy:function(this:{element:HTMLElement}) {
      if(owner.element!==this.element)return;
      owner.unbindEvents();owner.stopObserving();owner.page?.dispose();owner.page=undefined;owner.element=undefined;
    }});
  }
  private bindEvents():void {
    if(this.eventsBound)return;this.eventsBound=true;
    this.eventWindow?.addEventListener('reminderUpdated',this.invalidate);
    this.eventWindow?.addEventListener('focus',this.invalidate);
    this.eventDocument?.addEventListener('visibilitychange',this.invalidate);
  }
  private unbindEvents():void {
    if(!this.eventsBound)return;this.eventsBound=false;
    this.eventWindow?.removeEventListener('reminderUpdated',this.invalidate);
    this.eventWindow?.removeEventListener('focus',this.invalidate);
    this.eventDocument?.removeEventListener('visibilitychange',this.invalidate);
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
  private visible():boolean {return !!this.element&&isWorkPageVisible(this.element);}
  private stopObserving():void {
    this.visibilityObserver?.disconnect();this.visibilityObserver=undefined;
    this.queued=undefined;this.tasksInvalidated=false;this.wasVisible=false;
  }
  private observeVisibility(element:HTMLElement):void {
    this.wasVisible=this.visible();
    const Observer=element.ownerDocument.defaultView?.MutationObserver;
    if(!Observer)return;
    this.visibilityObserver=new Observer(()=>{
      if(this.disposed||this.element!==element)return;
      const visible=this.visible(),returned=visible&&!this.wasVisible;this.wasVisible=visible;
      if(visible&&(returned||this.tasksInvalidated))this.refreshTasks();
    });
    // SiYuan switches Custom panels with fn__none, without calling Custom.update.
    // Observe only this instance's visibility attributes and necessary ancestors.
    for(let current:HTMLElement|null=element;current;current=current.parentElement){
      this.visibilityObserver.observe(current,{attributes:true,attributeFilter:['class','style','hidden','aria-hidden']});
    }
  }
  refreshTasks():void {
    if(this.disposed||!this.page)return;
    this.tasksInvalidated=true;this.wasVisible=this.visible();
    if(this.queued||!this.wasVisible)return;
    const ticket={},page=this.page,element=this.element;this.queued=ticket;
    queueMicrotask(()=>{
      if(this.queued!==ticket)return;this.queued=undefined;
      if(this.disposed||this.page!==page||this.element!==element||!this.visible())return;
      this.tasksInvalidated=false;void page.refreshTasks();
    });
  }
  dispose(): void {this.disposed=true;this.unbindEvents();this.stopObserving();this.page?.dispose();this.page=undefined;this.element=undefined;}
}
