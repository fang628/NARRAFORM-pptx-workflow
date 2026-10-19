// Bounded discrete search driven by real PowerPoint text measurements.
const intersection=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
const finite=e=>e&&['x','y','w','h'].every(k=>Number.isFinite(e[k]))&&e.w>0&&e.h>0;
export function optimizeTextLayout(elements,measurements,{targetKeys=null}={}){
  const output=structuredClone(elements),changes=[],issues=[];
  const metrics=new Map((measurements||[]).map(m=>[m.key,m]));
  for(const e of output){
    if(e.type!=='text'||targetKeys&&!targetKeys.includes(e.key))continue;
    const m=metrics.get(e.key);
    if(!m||!Number.isFinite(m.boundWidth)||!Number.isFinite(m.boundHeight)||m.boundWidth<=0||m.boundHeight<=0)continue;
    const measuredSize=Number.isFinite(m.fontSize)&&m.fontSize>0?m.fontSize:e.size;
    const overflow=m.boundWidth>e.w+2||m.boundHeight>e.h+2||measuredSize<e.size*.98;
    if(!overflow)continue;
    const original={...e},obstacles=output.filter(o=>o.key!==e.key&&['text','image'].includes(o.type));
    let best=null;
    // Grow the carrier first. Font reduction is limited to 8%, at least 12 pt
    // unless the original was already smaller. No text/identity/font changes.
    const variants=[{}];
    // Preserve observed spacing unless real PowerPoint bounds overflow. Changes
    // are small, measured again on the next render, and never touch paragraph gaps.
    const lines=Number.isInteger(m.lineCount)&&m.lineCount>0?m.lineCount:0;
    const chars=Number.isFinite(m.maxLineCharacters)&&m.maxLineCharacters>1?m.maxLineCharacters:0;
    if(Number.isFinite(e.lineSpacing)&&lines>1)variants.push({lineSpacing:Math.max(Math.min(e.lineSpacing,e.size*1.05),e.lineSpacing*.95)});
    if(Number.isFinite(e.charSpacing)&&chars>1)variants.push({charSpacing:Math.max(-e.size*.04,e.charSpacing-e.size*.02)});
    if(variants.length===3)variants.push({...variants[1],...variants[2]});
    for(const scale of [1,.98,.96,.94,.92]){
      const size=e.size*scale;if(size<Math.min(e.size,20))continue;
      for(const spacing of variants){
        const oldChar=Number.isFinite(m.charSpacing)?m.charSpacing:e.charSpacing??0,newChar=spacing.charSpacing??e.charSpacing??oldChar;
        const measuredWidth=chars>1?(m.boundWidth-oldChar*(chars-1))*size/measuredSize+newChar*(chars-1):m.boundWidth*size/measuredSize;
        const dh=spacing.lineSpacing===undefined?0:(spacing.lineSpacing-(m.lineSpacing>0?m.lineSpacing:e.lineSpacing))*(lines-1);
        const requiredW=Math.max(size,measuredWidth)+2,requiredH=Math.max(size,(Number.isFinite(e.lineSpacing)&&lines>1?m.boundHeight+size-measuredSize:m.boundHeight*size/measuredSize)+dh)+2;
        for(const w of [...new Set([e.w,Math.max(e.w,requiredW),Math.max(e.w,e.w*1.1)])]){
          const h=Math.max(e.h,requiredH);
          if(w+1<requiredW||h>e.h*1.35||w>e.w*1.3)continue;
          const x=Math.min(e.x,1600-w),y=Math.min(e.y,900-h),candidate={...e,...spacing,x,y,w,h,size};
          if(!finite(candidate)||x<0||y<0||Math.abs(x-e.x)>32||Math.abs(y-e.y)>32)continue;
          if(obstacles.some(o=>intersection(candidate,o)>intersection(original,o)+1))continue;
          const cost=100*(1-scale)+Math.abs(x-e.x)+Math.abs(y-e.y)+(w-e.w+h-e.h)*.06+Object.entries(spacing).reduce((n,[k,v])=>n+Math.abs(v-e[k])/e.size*10,0);
          if(!best||cost<best.cost)best={candidate,cost};
        }
      }
    }
    if(best){Object.assign(e,best.candidate);changes.push({key:e.key,before:Object.fromEntries(['x','y','w','h','size','charSpacing','lineSpacing'].map(k=>[k,original[k]])),after:Object.fromEntries(['x','y','w','h','size','charSpacing','lineSpacing'].map(k=>[k,e[k]])),measurement:m});}
    else issues.push({key:e.key,message:'真实文字尺寸超出可用空间；局部约束搜索无安全解，交由模型修正',measurement:m});
  }
  return {elements:output,changes,issues};
}
