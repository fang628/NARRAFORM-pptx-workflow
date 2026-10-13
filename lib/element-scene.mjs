import {isTOCPage} from './page-options.mjs';
import {orderedElements} from './elements.mjs';
export function layoutCapacityError(message){const error=Error(message);error.code='NATIVE_LAYOUT_CAPACITY';return error;}
export function elementScene(s,t,index,total,brief,wrap){
  const out=[],nodes=s.elements,rect=(x,y,w,h,fill)=>out.push({type:'rect',x,y,w,h,fill});
  const text=(value,x,y,w,size,color,bold=false)=>wrap(value,w,size).forEach((text,i)=>out.push({type:'text',text,x,y:y+i*size*1.4,w,h:size*1.4,size,color,bold}));
  rect(0,0,1600,900,t.bg);rect(86,80,44,7,t.accent);
  const title=nodes.find(n=>n.role==='title'&&n.type==='text'),subtitle=nodes.find(n=>n.role==='subtitle'&&n.type==='text');
  const titleHeight=wrap(title.text,1420,52).length*72.8;if(titleHeight>220)throw layoutCapacityError('标题过长，请精简');text(title.text,86,120,1420,52,t.fg,true);
  let start=120+titleHeight+32;if(subtitle){text(subtitle.text,90,start,1420,26,t.muted);start+=wrap(subtitle.text,1420,26).length*36.4+24;}
  const roots=nodes.filter(n=>!n.parentId&&n!==title&&n!==subtitle);
  for(const header of [subtitle,title])if(header&&nodes.some(n=>n.parentId===header.id))roots.unshift({id:header.id,type:'virtual',layout:header.layout});
  const children=n=>nodes.filter(c=>c.parentId===n.id&&c!==subtitle);
  function ownHeight(n,w){if(n.type==='group')return wrap(n.label,w,28).length*39.2;if(n.type==='text')return wrap(n.text,w, n.role==='caption'?22:30).length*(n.role==='caption'?30.8:42);if(n.type==='image')return n.materialId?205:0;if(n.type==='shape')return 36;return 0;}
  function measure(n,w){if(w<80)throw layoutCapacityError('并排元素过密，请减少同组节点或改为纵向排列');const inner=n.type==='group'?w-36:w,cs=children(n),own=ownHeight(n,inner);const child=cs.length?(n.layout==='row'?Math.max(...cs.map(c=>measure(c,(inner-20*(cs.length-1))/cs.length))):cs.reduce((h,c)=>h+measure(c,inner)+16,0)-16):0;return Math.max(32,own+(own&&child?16:0)+child+(n.type==='group'?36:0));}
  const heights=roots.map(n=>measure(n,1420)),needed=heights.reduce((a,b)=>a+b,0)+Math.max(0,roots.length-1)*24,scale=Math.min(1,(806-start)/Math.max(needed,1));
  if(scale<.45)throw layoutCapacityError(`第 ${index+1} 页元素过多或文字过密，请减少内容或拆页`);
  function draw(n,x,y,w){const h=measure(n,w),group=n.type==='group';if(group)rect(x,y,w,h,t.panel);let px=x+(group?18:0),py=y+(group?18:0),inner=w-(group?36:0),own=ownHeight(n,inner);
    if(group)text(n.label,px,py,inner,28,t.fg,true);
    if(n.type==='text')text(n.text,px,py,inner,n.role==='caption'?22:30,n.role==='caption'?t.muted:t.fg,n.role!=='caption'&&children(n).length>0);
    if(n.type==='image'&&n.materialId)out.push({type:'image',id:n.materialId,x:px,y:py,w:inner,h:own});
    if(n.type==='shape')rect(px,py,inner,own,n.color);
    const cs=children(n);py+=own+(own&&cs.length?16:0);const cw=n.layout==='row'?(inner-20*(cs.length-1))/Math.max(cs.length,1):inner;
    cs.forEach((c,i)=>{draw(c,px+(n.layout==='row'?i*(cw+20):0),py,cw);if(n.layout!=='row')py+=measure(c,cw)+16;});
  }
  const first=out.length;let y=0;roots.forEach(n=>{draw(n,0,y,1420);y+=measure(n,1420)+24;});
  for(const e of out.slice(first)){e.x=90+e.x;e.y=start+e.y*scale;e.h*=scale;if(e.type==='text'){e.size*=scale;e.w*=1;}}
  text(String(index+1).padStart(2,'0')+' / '+String(total).padStart(2,'0'),1400,841,130,18,t.muted);if(brief.progress!==false&&s.kind!=='cover'&&!isTOCPage(s,index,brief))rect(86,16,1420*(index+1)/total,4,t.accent);
  for(const e of out)if(e.x<0||e.y<0||e.w<=0||e.h<=0||e.x+e.w>1601||e.y+e.h>901)throw layoutCapacityError('元素超出页面，请精简内容或拆页');
  return out;
}
