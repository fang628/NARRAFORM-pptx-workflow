import {isTOCPage} from './page-options.mjs';
import fs from 'node:fs';
import {validateElements,syncLegacy} from './elements.mjs';
import {elementScene,layoutCapacityError} from './element-scene.mjs';
import PptxGenJS from 'pptxgenjs';
import {containedImageBounds} from './image-geometry.mjs';

export const themes = [
  { id: 'a', name: '深海 · 商务叙事', description: '深蓝底色，清晰层次，适合战略汇报与项目路演。', bg: '101E35', fg: 'F3F6FC', muted: 'AABBD2', accent: '80E0C4', panel: '192B46', layout: 'split' },
  { id: 'b', name: '纸白 · 编辑风格', description: '暖白留白，橙色重点，适合研究分享与成果展示。', bg: 'F7F5EF', fg: '242B29', muted: '68746E', accent: 'D56540', panel: 'EAE7DE', layout: 'editorial' },
  { id: 'c', name: '蓝调 · 清晰结构', description: '明亮背景，蓝色结构，适合产品介绍与教学培训。', bg: 'EDF3FC', fg: '172B4D', muted: '647796', accent: '356DDF', panel: 'DFE8F8', layout: 'columns' },
];
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function wrap(text, width, fontSize) {
  const out = []; let line = '', used = 0;
  for (const c of String(text)) {
    const unit = c.codePointAt(0) > 255 ? fontSize : fontSize * .57;
    if (c === '\n' || (used + unit > width && line)) { out.push(line); line = ''; used = 0; }
    if (c !== '\n') { line += c; used += unit; }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}
export function validateSlides(slides,brief={}) {
  if (!Array.isArray(slides) || !slides.length || slides.length > 30) throw Error('页数须在 1–30 之间');
  return slides.map((s, i) => {
    if(s?.elements){s={...s,elements:validateElements(s.elements)};syncLegacy(s);}
    if (!s || typeof s.title !== 'string' || !s.title.trim() || s.title.length > 60) throw Error(`第 ${i+1} 页标题须为 1–60 字`);
    if (!Array.isArray(s.body) || s.body.length > 5 || s.body.some(t => typeof t !== 'string' || t.length > 180)) throw Error(`第 ${i+1} 页最多 5 段，每段不超过 180 字`);
    const subtitle = String(s.subtitle || '');
    if (subtitle.length > 120) throw Error(`第 ${i+1} 页副标题不能超过 120 字`);
    const notes = String(s.notes || '');
    if (notes.length > 8000) throw Error('备注过长');
    if(s.sourceLinks!==undefined&&(!Array.isArray(s.sourceLinks)||s.sourceLinks.length>60))throw Error('每页最多 60 条材料对应关系');
    const sourceLinks=(s.sourceLinks||[]).map((l,linkIndex)=>{
      const invalid=reason=>{throw Error(`第 ${i+1} 页第 ${linkIndex+1} 条材料对应关系格式无效：${reason}`);};
      if(!l||typeof l!=='object'||Array.isArray(l))invalid('须为包含 materialId 和 target 的对象');
      for(const key of ['materialId','target'])if(typeof l[key]!=='string'||!l[key].trim())invalid(`${key} 须为非空文字`);
      // Models express unused optional fields as omitted, null or empty strings.
      // Normalize those representations without coercing malformed values or evidence.
      for(const [key,limit] of [['quote',3000],['note',1000],['excerptId',60]]){
        if(l[key]!=null&&typeof l[key]!=='string')invalid(`${key} 须为文字或留空`);
        if((l[key]?.length||0)>limit)invalid(`${key} 不能超过 ${limit} 字`);
      }
      const excerptId=l.excerptId?.trim();
      // Preserve the exact bound original excerpt, including PDF boundary newlines.
      // Trimming it here changes source coordinates and invalidates a fresh design on save.
      return {id:typeof l.id==='string'?l.id.slice(0,100):undefined,materialId:l.materialId,target:l.target,quote:l.quote??'',note:(l.note??'').trim(),...(excerptId?{excerptId}:{}),...(typeof l.boundText==='string'?{boundText:l.boundText}:{})};
    });
    return { ...(s.elements?{elements:s.elements}:{}),title: s.title.trim(), subtitle, body: s.body, notes, kind: ['cover','toc','content','section'].includes(s.kind) ? s.kind : (i||brief.cover===false ? 'content' : 'cover'), sources: Array.isArray(s.sources) ? s.sources.map(String).slice(0,20) : [], sourceLinks, imageId: s.imageId ? String(s.imageId) : null };
  });
}
export function scene(slide, theme, index, total, brief = {}) {
  const t = theme || themes[0], elements = [];
  if(slide.elements)return elementScene(slide,t,index,total,brief,wrap);
  const rect = (x,y,w,h,fill) => elements.push({type:'rect',x,y,w,h,fill});
  const txt = (text,x,y,w,size,color=t.fg,bold=false,maxLines=20) => {
    const lines = wrap(text,w,size);
    if (lines.length > maxLines) throw layoutCapacityError(`第 ${index+1} 页文字过密，请缩短标题或正文`);
    lines.forEach((text,j) => elements.push({type:'text',text,x,y:y+j*size*1.4,w,h:size*1.4,size,color,bold}));
    return lines.length*size*1.4;
  };
  rect(0,0,1600,900,t.bg);
  rect(86,80,44,7,t.accent);
  if (slide.kind === 'cover') {
    rect(1120,0,480,900,t.panel); rect(1230,150,220,220,t.accent); rect(1160,430,350,7,t.accent);
    if (slide.imageId) elements.push({type:'image',id:slide.imageId,x:1050,y:140,w:460,h:590});
    txt(slide.title,86,210,slide.imageId?870:960,76,t.fg,true,3);
    txt(slide.subtitle || slide.body[0] || '',90,585,880,30,t.muted,false,3);
  } else {
    txt(slide.title,86,122,1400,54,t.fg,true,2);
    if (slide.subtitle) txt(slide.subtitle,90,290,1400,27,t.muted,false,2);
    const startY = slide.subtitle ? 400 : 325;
    if (t.layout === 'columns' && !slide.imageId && slide.body.length > 1 && slide.body.length <= 3) {
      const w = (1420-(slide.body.length-1)*42)/slide.body.length;
      slide.body.forEach((b,j) => { const x=90+j*(w+42); rect(x,startY,w,5,t.accent); txt(String(j+1).padStart(2,'0'),x,startY+32,w,42,t.accent,true); txt(b,x,startY+122,w,32,t.fg,false,7); });
    } else {
      const width = slide.imageId ? 855 : (t.layout === 'editorial' ? 1200 : 1340);
      let font=32;
      const needed=size=>slide.body.reduce((sum,b)=>sum+wrap(b,width-40,size).length*size*1.4+25,0);
      while(font>26&&startY+needed(font)>809)font-=1;
      let y = startY;
      slide.body.forEach((b,j) => { rect(92,y+15,7,7,t.accent); y += txt(b,126,y,width-40,font,t.fg,false,5)+25; });
      if (y>809) throw layoutCapacityError(`第 ${index+1} 页正文超出可用区域，请精简或拆页`);
      if (slide.imageId) elements.push({type:'image',id:slide.imageId,x:1040,y:startY,w:460,h:420});
    }
  }
  txt(String(index+1).padStart(2,'0')+' / '+String(total).padStart(2,'0'),1400,841,130,18,t.muted);
  if (brief.progress !== false && slide.kind!=='cover' && !isTOCPage(slide,index,brief)) rect(86,16,1420*(index+1)/total,4,t.accent);
  for(const e of elements) if(e.x<0||e.y<0||e.x+e.w>1601||e.y+e.h>901) throw layoutCapacityError(`第 ${index+1} 页元素越界，请缩短内容或拆页`);
  return elements;
}
export function svg(slide,theme,index,total,brief,imageURL=id=>`assets/${id}`,elements=null) {
  const el = (elements||scene(slide,theme,index,total,brief)).map(e => {
    if(e.type==='rect') return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" fill="#${e.fill}"/>`;
    if(e.type==='image') return `<image href="${esc(imageURL(e.id))}" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" preserveAspectRatio="xMidYMid meet"/>`;
    return `<text x="${e.x}" y="${e.y+e.size*1.08}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${e.size}" font-weight="${e.bold?700:400}" fill="#${e.color}">${esc(e.text)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1600 900">${el}</svg>`;
}
export async function buildDeck(project, destination, resolveImage) {
  const pptx = new PptxGenJS(); pptx.layout='LAYOUT_WIDE'; pptx.author='PPT Agent'; pptx.subject='Editable presentation'; pptx.title=project.brief.title;
  pptx.lang='zh-CN'; pptx.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei',lang:'zh-CN'};
  const slides=validateSlides(project.slides), theme=project.concepts.find(c=>c.id===project.selectedTheme)||themes[0];
  for(let i=0;i<slides.length;i++) {
    const slide=pptx.addSlide();
    for(const e of project.exportScenes?.[i]||scene(slides[i],theme,i,slides.length,project.brief)) {
      const box={x:e.x/120,y:e.y/120,w:e.w/120,h:e.h/120};
      if(e.type==='rect') slide.addShape(pptx.ShapeType.rect,{...box,line:{color:e.fill,transparency:100},fill:{color:e.fill},radius:0});
      else if(e.type==='text') slide.addText(e.text,{...box,fontFace:'Microsoft YaHei',fontSize:e.size*.6,bold:e.bold,color:e.color,margin:0,breakLine:false,paraSpaceAfterPt:0,valign:'mid',fit:'resize'});
      else { const file=resolveImage(e.id); if(!file||!fs.existsSync(file)) throw Error('图片不存在：'+e.id); slide.addImage({path:file,...containedImageBounds(fs.readFileSync(file),box)}); }
    }
    slide.addNotes([...(project.brief.speaker ? [slides[i].notes] : []),'来源材料：'+(slides[i].sources.join('、')||'用户说明／待核实')].filter(Boolean).join('\n'));
  }
  await pptx.writeFile({fileName:destination});
}
