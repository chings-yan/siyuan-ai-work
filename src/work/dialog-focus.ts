/** Keep keyboard navigation inside a mounted modal and restore its invoking control. */
export function trapDialogKey(event:KeyboardEvent,overlay:HTMLElement,busy:boolean,close:()=>void):void{
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)close();return;}
 if(event.key!=='Tab')return;
 const nodes=[...overlay.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex="0"]')].filter(el=>!el.closest('[hidden]')&&(!el.closest('details:not([open])')||el.tagName==='SUMMARY'));
 if(!nodes.length){event.preventDefault();overlay.focus();return;}
 const first=nodes[0],last=nodes[nodes.length-1],active=overlay.ownerDocument.activeElement;
 if(event.shiftKey&&(active===first||!overlay.contains(active))){event.preventDefault();last.focus();}
 else if(!event.shiftKey&&(active===last||!overlay.contains(active))){event.preventDefault();first.focus();}
}
