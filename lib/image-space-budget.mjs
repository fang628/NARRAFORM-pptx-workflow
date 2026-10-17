import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {initialElements} from './elements.mjs';

export const imageSpaceVersion='image-space-v2';
const canvas={w:1920,h:1080},body={x:96,y:250,w:1728,h:734};
const finite=n=>Number.isFinite(n)&&n>0;
export const imageSpacePlanningRule='先保证材料信息、关键结论、数字、单位、必要条件和独立分点完整，再优化可读性。图片可读尺寸只用于图文空间分配，图片较大或较多时不得减少分点、合并多段文字或把应上屏的信息移入notes。各段与各分点保留独立文字节点，同级观点优先并列组合，真实附属关系继续保留。空间紧张时先优化图文组合、列宽、间距和分区；可以在要求的总页数内完整地重新分配内容，不擅自增加页数或遗漏事实。不把内部测量和空间预算写成上屏文案或额外界面说明。';

export async function prepareImageReadability(p,{root,data,run,save=()=>{}}={},signal){
  if(!root||!data||!run)return;
  const pending=(p.materials||[]).filter(m=>m.kind==='image'&&!m.reconstructed&&m.purpose!=='workflow-background'&&m.purpose!=='reconstruction'&&m.imageReadability?.stamp!==`${imageSpaceVersion}:${m.sha256||m.file}`);
  if(!pending.length)return;
  const dir=path.join(data,p.id,'planning');fs.mkdirSync(dir,{recursive:true});
  const input=path.join(dir,'image-readability-'+crypto.randomUUID()+'.json');
  fs.writeFileSync(input,JSON.stringify(pending.map(m=>({id:m.id,file:path.join(data,p.id,'assets',m.file)}))));
  const local=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  try{
    signal?.throwIfAborted();
    const result=await run(process.env.PPT_AGENT_PYTHON||(fs.existsSync(local)?local:'python'),[path.join(root,'tools','image_readability.py'),input],{windowsHide:true,timeout:120000,maxBuffer:2000000,signal});
    signal?.throwIfAborted();
    for(const item of JSON.parse(result.stdout)){
      const m=pending.find(m=>m.id===item.id);if(!m||item.error||!finite(item.width)||!finite(item.height))continue;
      m.width=item.width;m.height=item.height;m.imageReadability={...item,version:imageSpaceVersion,stamp:`${imageSpaceVersion}:${m.sha256||m.file}`};
    }
    save(p);
  }catch(error){if(signal?.aborted)throw error;/* Optional local estimation never blocks content generation. */}
  finally{try{fs.unlinkSync(input);}catch{}}
}

export function minimumImageSize(m={},reading){
  const width=finite(m.width)?m.width:1200,height=finite(m.height)?m.height:800,aspect=width/height;
  const detail=m.imageReadability?.detailHeightPx;
  const description=[m.name,reading?.summary,reading?.suggestedUse,m.supplementImage?.caption].join(' ');
  const dense=finite(detail)||/图表|曲线|质谱|组合图|机理|路线|流程|figure|chart|diagram/i.test(description);
  // 24px at 1080p corresponds to a 12pt figure label on a 7.5in slide.
  // This is a planning estimate, not a guarantee of semantic legibility.
  const scale=finite(detail)?24/detail:Math.max((dense?680:420)/width,(dense?260:220)/height);
  return {w:Math.ceil(width*scale),h:Math.ceil(height*scale),aspect,confidence:finite(detail)?'estimated':'fallback'};
}

export function pageImageBudget(p,slide){
  const nodes=initialElements(slide),readings=p.analysis?.readings||[];
  const images=nodes.filter(n=>n.type==='image'&&n.materialId).map(n=>{
    const m=(p.materials||[]).find(m=>m.id===n.materialId)||{},minimum=minimumImageSize(m,readings.find(r=>r.id===m.id));
    return {nodeId:n.id,id:n.materialId,label:n.label,minimum};
  });
  const textNodes=nodes.filter(n=>n.type==='text'&&n.role==='body'),textCharacters=textNodes.reduce((sum,n)=>sum+Array.from(n.text||'').length,0),textPoints=textNodes.length;
  const textAreaFraction=Math.min(.72,Math.max(.24,(textCharacters*1000+textPoints*4000)/(body.w*body.h))),availableImageFraction=1-textAreaFraction;
  const contentSpace={textCharacters,textPoints,textAreaFraction};
  if(!images.length)return {version:imageSpaceVersion,canvas,images:[],...contentSpace,imageAreaFraction:0};
  const candidates=[];
  for(const fraction of [...new Set([.24,.34,.42,.54,.66,.76,availableImageFraction])])for(const orientation of ['right','bottom'])for(let cols=1;cols<=Math.min(4,images.length);cols++){
    const region=orientation==='right'?{x:body.x+body.w*(1-fraction),y:body.y,w:body.w*fraction,h:body.h}:{x:body.x,y:body.y+body.h*(1-fraction),w:body.w,h:body.h*fraction};
    const rows=Math.ceil(images.length/cols),cellW=(region.w-24*(cols-1))/cols,cellH=(region.h-24*(rows-1))/rows;
    const slots=images.map((im,i)=>{
      const w=Math.min(cellW,cellH*im.minimum.aspect),h=w/im.minimum.aspect;
      return {...im,x:region.x+(i%cols)*(cellW+24)+(cellW-w)/2,y:region.y+Math.floor(i/cols)*(cellH+24)+(cellH-h)/2,w,h,readableScale:Math.min(w/im.minimum.w,h/im.minimum.h)};
    });
    const deficit=slots.reduce((sum,e)=>sum+Math.max(0,1-e.readableScale),0);
    candidates.push({slots,fraction,orientation,deficit,score:Math.max(0,fraction-availableImageFraction)*100+deficit*10+fraction});
  }
  const best=candidates.sort((a,b)=>a.score-b.score)[0];
  return {version:imageSpaceVersion,canvas,images:best.slots,layout:best.orientation,...contentSpace,imageAreaFraction:best.fraction,minimumsFit:best.deficit<.01};
}

export function imagePlanningContext(p,slide){
  const budget=pageImageBudget(p,slide);
  return budget.images.length?'内部图片空间预算（仅供规划，不上屏）：'+JSON.stringify(budget)+'\n文字空间按已有正文与独立分点估算，不是字数或分点上限。信息完整优先，其次优化可读性；不得按图片数量删减或合并正文。围绕既有文字与配图安排空间，无法兼顾时记录布局问题，保留完整内容继续。':'';
}

export function plannedImageGeometry(p,index,images){
  const budget=pageImageBudget(p,p.slides[index]);
  const result=images.map(e=>{
    const slot=budget.images.find(s=>s.nodeId===e.nodeId);if(!slot)return e;
    const w=slot.w/1.2,h=slot.h/1.2;
    return {...e,x:finite(e.x)?Math.min(1600-w,Math.max(0,e.x)):slot.x/1.2,y:finite(e.y)?Math.min(900-h,Math.max(0,e.y)):slot.y/1.2,w,h,plannedSize:{w:Math.round(slot.w),h:Math.round(slot.h)},minimumReadableSize:slot.minimum};
  });
  const overlaps=result.some((a,i)=>result.slice(i+1).some(b=>Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x)+.01&&Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y)+.01));
  return overlaps?result.map(e=>{const s=budget.images.find(s=>s.nodeId===e.nodeId);return s?{...e,x:s.x/1.2,y:s.y/1.2}:e;}):result;
}

export const imageSizeText=e=>{
  const size=e.plannedSize||(finite(e.w)&&finite(e.h)?{w:e.w*1.2,h:e.h*1.2}:null);
  return size&&finite(size.w)&&finite(size.h)?`${Math.round(size.w)}×${Math.round(size.h)} px`:'';
};

export function preserveImageSizes(original,next){
  const before=String(original).match(/\d+\s*[×x]\s*\d+\s*px/g)||[];
  const normalize=value=>String(value).replace(/\s/g,'').replace(/x/g,'×'),after=normalize(next);
  for(const size of new Set(before)){const token=normalize(size);if(after.split(token).length-1<before.filter(s=>normalize(s)===token).length)throw Error('提示词整理遗漏了已规划的图片占位框尺寸，保留上一有效稿');}
}
