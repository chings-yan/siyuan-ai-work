import type { WorkCreator } from './create.ts';

const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
type Draft={workId:string;title:string;goal:string;pending:boolean;attempted:boolean;busy:boolean;done:boolean;error:string;notice:string};

/** A later Goal is an explicit write; pending attempts are reconciled without another native write. */
export class WorkGoalForm {
  private element?:HTMLElement;
  private draft?:Draft;
  constructor(private readonly creator:Pick<WorkCreator,'goalPending'|'addGoal'>,private readonly onComplete:()=>Promise<void>){}
  async open(workId:string,title:string,currentGoal=''):Promise<void>{
    if(this.element){this.element.querySelector<HTMLElement>('button')?.focus();return;}
    const draft:Draft={workId,title,goal:currentGoal,pending:false,attempted:false,busy:true,done:false,error:'',notice:''};
    this.draft=draft;this.element=document.createElement('div');this.element.className='sac-create-overlay';
    this.element.addEventListener('click',event=>{void this.click(event);});
    this.element.addEventListener('input',event=>{const target=event.target as HTMLTextAreaElement;if(this.draft===draft&&target.name==='goal'&&!draft.pending)draft.goal=target.value;});
    document.body.appendChild(this.element);this.render();
    try{
      const pending=await this.creator.goalPending(workId);
      if(this.draft!==draft)return;
      if(pending){
        const value=JSON.parse(pending.details) as {version?:number;goal?:unknown;attempted?:unknown};
        if(value.version!==1||typeof value.goal!=='string'||typeof value.attempted!=='boolean')throw new Error('目标待核对记录格式错误，请人工核对');
        draft.pending=true;draft.goal=value.goal;draft.attempted=value.attempted;
        draft.notice=value.attempted?'上次目标写入结果待核对；本次只读回检查，不会再次写入。':'已有未完成的目标记录；本次只核对文档，不会再次写入。';
      }else if(currentGoal){draft.done=true;draft.notice='这篇 Work 已有目标；此处仅供查看，不会覆盖原文档中的目标。';}
    }catch(error){if(this.draft===draft)draft.error=`目标记录读取失败：${errorText(error)}`;}
    if(this.draft===draft){draft.busy=false;this.render();}
  }
  dispose():void{this.element?.remove();this.element=undefined;this.draft=undefined;}
  private async click(event:Event):Promise<void>{
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-goal-action]'),draft=this.draft;
    if(!button||!draft||draft.busy)return;
    if(button.dataset.goalAction==='close'){this.dispose();return;}
    if(button.dataset.goalAction!=='submit'||draft.done||draft.error.startsWith('目标记录读取失败'))return;
    const goal=draft.goal.trim();if(!goal){draft.error='请填写要添加的目标';this.render();return;}
    if(!draft.pending&&!window.confirm(`向 Work “${draft.title}”（${draft.workId}）添加目标：\n\n${goal}\n\n确认后将把目标写到主文档最上方；现有文档和关系保留。`))return;
    draft.busy=true;draft.error='';draft.notice='';this.render();
    try{
      const result=await this.creator.addGoal(draft.workId,goal,true);
      if(this.draft!==draft)return;
      draft.notice=result.message;
      if(result.kind==='complete'){draft.done=true;await this.onComplete();}
      else{
        const pending=await this.creator.goalPending(draft.workId);
        if(this.draft!==draft)return;
        if(pending){const value=JSON.parse(pending.details) as {attempted?:boolean};draft.pending=true;draft.attempted=value.attempted===true;}
      }
    }catch(error){if(this.draft===draft)draft.error=errorText(error);}
    finally{if(this.draft===draft){draft.busy=false;this.render();}}
  }
  private render():void{
    const d=this.draft,e=this.element;if(!d||!e)return;
    e.innerHTML=`<section class="sac-create-form" role="dialog" aria-modal="true" aria-label="Work 目标"><header><h2>Work 目标</h2><button type="button" data-goal-action="close" ${d.busy?'disabled':''}>关闭</button></header><p>Work：${esc(d.title)} · ${esc(d.workId)}</p>${d.notice?`<p role="status">${esc(d.notice)}</p>`:''}${d.error?`<p role="alert">${esc(d.error)}</p>`:''}${d.done&&d.goal?`<p>当前目标：${esc(d.goal)}</p>`:''}${!d.done?`<label>工作目标<textarea name="goal" rows="3" ${d.pending?'readonly':''} ${d.busy?'disabled':''}>${esc(d.goal)}</textarea></label><button type="button" data-goal-action="submit" ${d.busy||d.error.startsWith('目标记录读取失败')?'disabled':''}>${d.attempted||d.pending?'核对上次目标写入':'确认添加目标'}</button>`:''}</section>`;
  }
}
