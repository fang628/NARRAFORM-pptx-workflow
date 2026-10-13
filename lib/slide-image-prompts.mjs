import {nestedContentList} from './prompt-structure.mjs';
import {specialLayoutImageGuidance} from './layout-guidance.mjs';
import {initialElements,orderedElements} from './elements.mjs';
import {pageDesignState} from './page-design.mjs';
import {academicContext,navigationTexts,pageNeedsImage,designRulesFor} from './design-rules.mjs';
import {canonicalTexts} from './visual-model.mjs';
import {themeAssetForPage} from './theme-assets.mjs';
import {imageStyle,compactVisualText} from './image-prompts.mjs';

export const imagePromptVersion='workflow-image-prompt-v8';
export const creativeLayoutRequirement='实际排版要有创意，保留合理的组合与局部构图发挥空间。';
const backgroundUse='无字底图原样作为最终PPT页面背景，保留主体位置、底色与纹理；文字及新增图形独立叠加，不覆盖全页。';
const role=n=>({title:'标题',subtitle:'副标题',body:'正文',caption:'注释',heading:'小标题',navigation:'页顶导航'}[n.role]||'正文');
const line=v=>String(v??'').replace(/\r?\n/g,' / ');

export function slideImagePrompt(p,index,direction,images,mode='full'){
  const s=p.slides[index],d=pageDesignState(p,index),base=themeAssetForPage(p,index,direction.id);
  const nodes=orderedElements(initialElements(s)),nav=navigationTexts(p,index);
  // Geometry, font sizes and engineering IDs belong to local plans, never to the image brief.
  const names=new Map([...nodes.map(n=>[n.id,n.type==='text'?(n.role==='title'?'主标题':n.role==='subtitle'?'副标题':n.label||role(n)):n.label]),...p.materials.map(m=>[m.id,m.name])]);
  const description=value=>{
    let text=line(value);
    for(const [id,name] of [...names].sort((a,b)=>b[0].length-a[0].length))text=text.replace(new RegExp('(?<![\\w-])'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\w-])','g'),'“'+line(name)+'”');
    return text.replace(/\b\d+(?:\.\d+)?\s*(?:pt|px|磅|像素)\b/gi,'').replace(/\b(?:x|y|w|h)\s*[:=]\s*\d+(?:\.\d+)?/gi,'').replace(/；\s*；/g,'；');
  };
  const carrierShape=spec=>spec?.carrier&&/(弧形|扇形|异形|斜切|阶梯|波浪|同心|蜂窝|金字塔|放射|圆域|裁切)/.test(spec.carrier)?compactVisualText(description(spec.carrier).replace(/#[\da-f]{6}\b/gi,'所选方向配色'),100):null;
  const layout=nodes.map(n=>{
    const spec=d.plan.nodes.find(o=>o.id===n.id);
    let depth=0,parent=n.parentId;const seen=new Set();while(parent&&!seen.has(parent)){seen.add(parent);depth++;parent=nodes.find(o=>o.id===parent)?.parentId;}
    const peers=nodes.filter(o=>o.type===n.type&&o.role===n.role&&o.parentId===n.parentId),label=n.label&&n.label!==n.text&&n.label!==role(n)?`“${line(n.label)}”`:`第 ${peers.findIndex(o=>o.id===n.id)+1} 项`;
    const content=n.type==='image'?`图片“${line(n.label)}”`:n.type==='group'?`小标题：“${line(n.label)}”`:n.type==='text'?['title','subtitle'].includes(n.role)?role(n):`${role(n)}：${label}`:`图形“${line(n.label)}”`;
    const relation=spec?.relation&&!/(从属|附属|归属|并列|统领)/.test(spec.relation)?spec.relation:null;
    return `${'  '.repeat(depth+1)}- ${content}；${[spec?.position,spec?.relativeSize,spec?.alignment,relation,carrierShape(spec)].filter(Boolean).map(description).filter((v,i,a)=>a.indexOf(v)===i).join('；')||'依上级分块阅读顺序排布'}。`;
  }).join('\n');
  const pictures=images.map(e=>{
    const n=nodes.find(n=>n.id===e.nodeId),spec=d.plan.nodes.find(n=>n.id===e.nodeId);
    return `  - “${line(n?.label||'配图')}”：${description(spec?.position||'对应内容旁')}，宽高比 ${Number((e.aspect||e.w/e.h).toPrecision(3))}:1，平坦无字占位块${nodes.some(c=>c.parentId===n?.id&&c.role==='caption')?'，下方留图注空间':''}。`;
  }).join('\n');
  const titlePage=s.kind==='cover'||s.kind==='toc',kind={cover:'标题页',toc:'目录页',section:'章节页',thanks:'致谢页'}[s.kind]||'内容页';
  const foundation=p.themeAssets?.directions?.find(d=>d.id===direction.id),subject=s.kind==='cover'?foundation?.heroSubject:foundation?.tocSubject;
  const imageUse=base?(titlePage?`在随附原底图上构建，保留${subject?description(subject):'主题主体'}、核心底色及文字预留区；只保留一个取自材料且明显可见的主视觉，铺满分配的视觉区；保留少量主题场景点缀，避免主体孤立，不形成竞争主体或重复主视觉，不缩成角落小图；不为底图加图注或占位框。`:'在随附对应内容底图上构建，延续核心底色、主题元素和阅读留白，正文和证据优先。'):pageNeedsImage(p,index)&&!images.length?'安排服务本页主题的非事实示意，与文字分开。':!images.length?'本页无配图，不增添插画或图片占位框。':'';
  return `- **比例要求**：${kind}，完整PowerPoint${mode==='concept'?'方向代表页':'整页预览'}，16:9（1920×1080），无页面外框。
- **内容要求**：下列文案表达语义与体量，不新增事实或文案；嵌套子项从属于上级，同一父项下的同级正文为并列，副标题仅作标题附文。
${nestedContentList(nodes,nav)}
- **排版要求**：主标题统领全页，副标题附属主标题，均不参与正文并列；各文段独立，缩进表示从属，同级正文表示并列，保持以下层级与顺序，可自由组织局部构图。${description(d.plan.layoutIntent)}。${specialLayoutImageGuidance}
${layout}
- **${titlePage?'底图与配图要求':'图片占位框比例'}**：${imageUse}${base?backgroundUse:''}${images.length?'登记原图仅画等比、平坦无字占位块，不重画事实内容；展示前本地贴回原件，完整保留主体、图例与标签。':''}
${pictures}
- **风格要求**：${description(imageStyle(direction))}。${creativeLayoutRequirement}文本框底色和背景主色之间要有色差。
  - **简约要求**：${academicContext(p)?'文本框内尽量不要有渐变；装饰色块平整、边界清晰。':''}承载干净，文字区安静。
  - **紧密排版要求**：同组紧邻，框高适配文案，正文优先，不靠缩小文字。
- **进度条要求**：${nav.length?'页顶且仅一条粗分段进度条，逐段写“'+nav.map(n=>n.text).join('”“')+'”；当前“'+nav.find(n=>n.current)?.text+'”加粗并以强调色突出，其余段有深浅色差。':'无进度条。'}
- **可读性要求**：文字清晰、层级分明、对比充分，科学数字和单位完整。
- **视觉关系要求**：${description(d.plan.logic)}；分组、连接与图文对应反映真实关系，不新增无依据因果箭头。`.trim();
}

// User drafts and repairs keep their own complete brief, with a short execution boundary.
// Do not append the entire design/review policy to the drawing request.
export function effectiveSlideImagePrompt(p,index,direction,images,mode,override){
  if(!override)return slideImagePrompt(p,index,direction,images,mode);
  let brief=String(override).trim().replaceAll('\n'+designRulesFor(p,index,'image'),'')
    .replace(/\n*【占位框比例修正】[\s\S]*?【占位框比例修正结束】/g,'')
    .replaceAll('随附内容背景仅作风格参考，按需采用，正文和证据优先。','在随附对应内容底图上构建，延续核心底色、主题元素和阅读留白，正文和证据优先。')
    .replaceAll('\n登记原图必须使用等比、无字的平坦占位块；不得生成原图内容。展示前由本地合成原图。','')
    .replaceAll('\n整页画布必须为16:9，1920×1080为优先目标，允许较小的16:9尺寸。','')
    .replaceAll('创意排版，特殊分块与弧形、扇形、斜切、阶梯等异形承载可结合内容自由组合。',creativeLayoutRequirement)
    .replace(/^- \*\*原图保真要求\*\*：[^\n]*\n?/gm,'')
    .replace(/\n【本次生成边界】[^\n]*/g,'');
  const nav=navigationTexts(p,index);
  const headers=[...brief.matchAll(/^- \*\*([^*]+)\*\*：/gm)],complete=headers.length===8&&['比例要求','内容要求','排版要求','风格要求','进度条要求','可读性要求','视觉关系要求'].every(name=>headers.some(h=>h[1]===name));
  const additions=[];
  const supply=(section,text)=>{
    if(!complete){additions.push(text);return;}
    const all=[...brief.matchAll(/^- \*\*([^*]+)\*\*：/gm)],at=all.findIndex(h=>h[1]===section);
    if(at<0){additions.push(text);return;}
    const end=all[at+1]?.index??brief.length;
    brief=brief.slice(0,end).trimEnd()+'\n  - '+text+'\n'+brief.slice(end);
  };
  if(!brief.includes('16:9')||!brief.includes('1920×1080'))supply('比例要求','画布16:9（1920×1080）。');
  if(!brief.includes(direction.coreColor))supply('风格要求',`核心底色 ${direction.coreColor}，以本方向配色为准。`);
  if(!brief.includes(creativeLayoutRequirement)&&!/排版.{0,12}创意[\s\S]{0,50}(?:局部构图|组合|发挥空间)/.test(brief))supply('风格要求',creativeLayoutRequirement);
  if(!/文本框.{0,20}(?:背景|主色).{0,15}(?:色差|对比|区分)/.test(brief))supply('风格要求','文本框底色和背景主色之间要有色差。');
  if(academicContext(p)&&!brief.includes('文本框内尽量不要有渐变'))supply('风格要求','**简约要求**：文本框内尽量不要有渐变。');
  if(!/\*\*紧密排版要求\*\*/.test(brief))supply('风格要求','**紧密排版要求**：分组紧凑，正文空间充分，不靠缩小文字。');
  const imageSection=['cover','toc'].includes(p.slides[index].kind)?'底图与配图要求':'图片占位框比例';
  if(!/(?:在|基于|沿用|使用).{0,20}(?:随附|对应|原|已选|已确认).{0,8}底图.{0,20}(?:构建|叠加|排版|图生图)/.test(brief))supply(imageSection,'必须在随附对应底图上构建本页，延续其主题主体、核心底色与阅读留白；使用图生图，不重新另起底图。');
  if(!/(?:底图|背景图).{0,30}(?:原样|直接|不变).{0,20}(?:PPT|页面).{0,8}背景/.test(brief))supply(imageSection,backgroundUse);
  if(images.length){
    if(!/(?:等比|宽高比)[^。\n]{0,35}占位|占位[^。\n]{0,35}(?:等比|宽高比)/.test(brief))supply(imageSection,'登记原图用等比、平坦无字占位块。');
    if(!/(?:不|禁止|不得).{0,6}(?:重画|重绘|生成).{0,12}(?:事实|原图|原件)|(?:原图|原件).{0,6}(?:不|禁止|不得).{0,6}(?:重画|重绘|生成)/.test(brief))supply(imageSection,'不重画事实内容。');
    if(!/(?:本地|展示前).{0,12}(?:贴回|回填|插回|插入).{0,8}(?:原件|原图)/.test(brief))supply(imageSection,'展示前本地贴回原件，保留主体、图例与标签。');
  }
  if(nav.length&&(!/页顶|顶部/.test(brief)||!nav.every(n=>brief.includes(n.text))))supply('进度条要求','页顶且仅一条粗分段进度条，逐段写“'+nav.map(n=>n.text).join('”“')+'”；当前“'+nav.find(n=>n.current)?.text+'”突出，其余段有色差。');
  if(!nav.length&&!brief.includes('无进度条'))supply('进度条要求','无进度条。');
  return brief.trim()+(additions.length?'\n【本次生成边界】'+additions.join(''): '');
}
