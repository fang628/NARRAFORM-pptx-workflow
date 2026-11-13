// The table owns its cell's text anchor. Generic parent fitting may not shrink
// that box again; actual glyph bounds are calibrated after fonts are final.
export const TABLE_TEXT_LAYOUT_VERSION=1;
export function tableTextPlacement(element,measured){
  const {left,right,top,bottom}=measured;
  if(![left,right].every(Number.isFinite)||right-left<8)return element;
  const align=measured.align,pad=Math.min(Math.max(2,measured.inset??4),(right-left)*.3);
  let x=left+pad,w=right-left-2*pad;
  const cx=(left+right)/2+(measured.centerOffset??0);
  if(align==='center'){w=Math.max(4,2*Math.min(cx-left-pad,right-pad-cx));x=cx-w/2;}
  const vertical=[top,bottom,measured.inkTop,measured.inkBottom].every(Number.isFinite)&&bottom>top+4;
  const targetX=align==='center'?cx:align==='right'?right-pad:left+pad;
  return {...element,x,w,align,...(vertical?{y:top+2,h:bottom-top-4,valign:'mid'}:{}),
    tableAlignment:{...measured,version:TABLE_TEXT_LAYOUT_VERSION,independent:false,inherited:true,
      targetX,targetY:vertical?(measured.inkTop+measured.inkBottom)/2:null}};
}
export function calibrateTableText(element,measurement){
  const a=element.tableAlignment;
  if(a?.version!==TABLE_TEXT_LAYOUT_VERSION||![a.targetX,measurement.boundLeft,measurement.boundTop,measurement.boundWidth,measurement.boundHeight].every(Number.isFinite))return null;
  if([measurement.inkLeft,measurement.inkTop,measurement.inkWidth,measurement.inkHeight].every(Number.isFinite))measurement={...measurement,boundLeft:measurement.inkLeft,boundTop:measurement.inkTop,boundWidth:measurement.inkWidth,boundHeight:measurement.inkHeight};
  const actualX=a.align==='center'?measurement.boundLeft+measurement.boundWidth/2:a.align==='right'?measurement.boundLeft+measurement.boundWidth:measurement.boundLeft;
  if(measurement.boundWidth>a.right-a.left-2||Number.isFinite(a.top)&&measurement.boundHeight>a.bottom-a.top-2)return {element,changed:false,issue:'实测字形超出单元格空间，需要调整字号或换行'};
  const bounded=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const dx=bounded(a.targetX-actualX,a.left+1-measurement.boundLeft,a.right-1-measurement.boundLeft-measurement.boundWidth);
  const dy=Number.isFinite(a.targetY)?bounded(a.targetY-measurement.boundTop-measurement.boundHeight/2,a.top+1-measurement.boundTop,a.bottom-1-measurement.boundTop-measurement.boundHeight):0;
  const tolerance=Number.isFinite(measurement.inkLeft)?1.1:.75;
  if(Math.abs(dx)<tolerance&&Math.abs(dy)<tolerance)return {element,changed:false};
  const safe=measurement.boundLeft+dx>=a.left+1&&measurement.boundLeft+measurement.boundWidth+dx<=a.right-1
    &&(!Number.isFinite(a.top)||measurement.boundTop+dy>=a.top+1&&measurement.boundTop+measurement.boundHeight+dy<=a.bottom-1);
  if(!safe||Math.abs(dx)>32||Math.abs(dy)>32)return {element,changed:false,issue:'实测字形超出单元格空间，需要调整字号或换行'};
  return {element:{...element,x:element.x+dx,y:element.y+dy},changed:true,dx,dy};
}
