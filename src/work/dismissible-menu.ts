/** Capture editor events before its own handlers can stop propagation. */
export function bindDismissibleMenu(anchor: HTMLElement | null, menu: HTMLElement | null, button: HTMLElement | null, close: () => void): () => void {
  if(!anchor||!menu)return ()=>{};
  const doc=anchor.ownerDocument;
  const outside=(event:Event)=>{if(!menu.hidden&&!anchor.contains(event.target as Node))close();};
  const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!menu.hidden){event.preventDefault();close();button?.focus();}};
  doc.addEventListener('pointerdown',outside,true);doc.addEventListener('click',outside,true);doc.addEventListener('keydown',keydown,true);
  return ()=>{doc.removeEventListener('pointerdown',outside,true);doc.removeEventListener('click',outside,true);doc.removeEventListener('keydown',keydown,true);};
}
