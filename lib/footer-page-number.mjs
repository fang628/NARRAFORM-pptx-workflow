import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {isTOCPage} from './page-options.mjs';
import {themeAssetForPage} from './theme-assets.mjs';
import {fontCategory} from './native-fonts.mjs';
const hex=v=>typeof v==='string'&&/^[0-9a-f]{6}$/i.test(v)?v.toUpperCase():null;
const rgb=h=>h.match(/../g).map(v=>parseInt(v,16));
const blend=(a,b,t)=>rgb(a).map((v,i)=>Math.round(v*(1-t)+rgb(b)[i]*t).toString(16).padStart(2,'0')).join('').toUpperCase();
const light=h=>rgb(h).map(v=>{const s=v/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>(Math.max(light(a),light(b))+.05)/(Math.min(light(a),light(b))+.05);
export const footerPageVersion=3;
export const footerPageRule='开启页脚页码时，05由程序统一生成右下角小型直角梯形页码承载和加粗数字，右侧竖直、上下边水平、左侧斜切，底框右边与页面右边、底框下边与页面下边齐平，不留角部外边距；数字仅保留框内间距。使用实际幻灯片页序；封面与目录不显示。页码不属于材料内容、预览原有数字或需拆解的元素，不新增对应内容树项。程序提供的nf-footer-*对象不能改写、移动、删除或重复拆解。保留右下角页码区域，其余内容避开；页码与参考图不同是用户选择的新增项，不因此判预览不相似。';
export const isFooterElement=e=>e?.managed==='footer'||e?.key?.startsWith('nf-footer-');
export const footerPageEligible=(p,index)=>p.pageNumbers===true&&!!p.slides[index]&&p.slides[index].kind!=='cover'&&!isTOCPage(p.slides[index],index,p.brief);
export async function prepareFooterReference(p,env,signal){
  if(p.pageNumbers!==true)return;
  const pages=p.slides.flatMap((_,i)=>footerPageEligible(p,i)?[i]:[]),counts=new Map();
  for(const i of pages){const bg=themeAssetForPage(p,i,p.selectedTheme);if(bg)counts.set(bg.materialId,{asset:bg,index:i,count:(counts.get(bg.materialId)?.count||0)+1});}
  const source=[...counts.values()].sort((a,b)=>b.count-a.count)[0];if(!source)return;
  const signature=crypto.createHash('sha256').update(JSON.stringify([1,p.selectedTheme,source.asset.previewHash])).digest('hex');
  if(p.footerStyleReference?.signature===signature)return;
  try{
    const file=env.getImage(p,source.asset.materialId);if(!file||!fs.existsSync(file))return;
    const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    const r=await env.run(python,[path.join(env.root,'tools/footer_style.py'),file],{windowsHide:true,timeout:30000,maxBuffer:200000,signal}),colors=JSON.parse(r.stdout);
    if(!hex(colors.background)||!hex(colors.accent))return;
    p.footerStyleReference={signature,theme:p.selectedTheme,materialId:source.asset.materialId,previewHash:source.asset.previewHash,background:colors.background,accent:colors.accent};env.save(p);
  }catch(error){if(signal?.aborted)throw error;/* Keep the theme-derived style if pixel sampling is unavailable. */}
}
export function footerStyle(p,progress){
  if(p.pageNumbers!==true)return null;
  const theme=p.concepts?.find(c=>c.id===p.selectedTheme)||{},reference=p.footerStyleReference?.theme===p.selectedTheme?p.footerStyleReference:null;
  const bg=hex(reference?.background)||hex(theme.coreColor?.replace('#',''))||'F5F5F2',ink=contrast(bg,'252525')>=contrast(bg,'FAFAF7')?'252525':'FAFAF7';
  const fill=blend(bg,ink,.16),accent=hex(reference?.accent)||progress.accent;
  const shape='trapezoid';
  const fonts=(p.reconstruction?.slides||[]).flatMap(page=>page.elements||[]).filter(e=>e.type==='text'&&!e.managed&&!['title','navigation'].includes(e.role)&&e.fontFace&&!['calligraphy','artistic'].includes(fontCategory(e.fontFace)));
  const votes=new Map();for(const e of fonts)votes.set(e.fontFace,(votes.get(e.fontFace)||0)+1);
  const defaultFont=/serif|衬线|宋体|Times|Cambria/i.test(theme.typography||'')&&!/sans|无衬线/i.test(theme.typography||'')?'Times New Roman':'Arial';
  return {shape,x:1600-48,y:900-32,w:48,h:32,size:18,fontFace:[...votes].sort((a,b)=>b[1]-a[1])[0]?.[0]||defaultFont,color:contrast(fill,'252525')>=contrast(fill,'FAFAF7')?'252525':'FAFAF7',fill,border:contrast(fill,accent)>=1.5?accent:blend(fill,ink,.45),strokeWidth:.8};
}
export function footerPageElements(p,index){
  const s=p?.rebuildPresentation?.footer;if(!s||!footerPageEligible(p,index))return [];
  return [
    {key:'nf-footer-badge',type:'shape',shape:'trapezoid',footerGeometry:{kind:'right-trapezoid',inset:s.w*.25},managed:'footer',x:s.x,y:s.y,w:s.w,h:s.h,fill:s.fill,color:s.border,strokeWidth:s.strokeWidth,opacity:1},
    {key:'nf-footer-number',type:'text',nodeId:'footer-page-number',role:'page-number',managed:'footer',text:String(index+1).padStart(2,'0'),x:s.x+4,y:s.y+4,w:s.w-8,h:s.h-8,size:s.size,fontFace:s.fontFace,color:s.color,bold:true,italic:false,align:'center',valign:'mid',noWrap:true}
  ];
}
