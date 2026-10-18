import {creativeStyleInstruction,visualConnectionInstruction,arrowInstructionsOnly} from './layout-guidance.mjs';
import {presetNavigation} from './preset-design.mjs';
import {placeholderCountRule} from './image-placeholder-rules.mjs';
import {promptColor,simplifyPromptColors} from './prompt-colors.mjs';
import {nestedContentList,deduplicateSlidePrompt} from './prompt-structure.mjs';
import {imageCaptionRule} from './image-caption-rules.mjs';
import {initialElements,orderedElements} from './elements.mjs';
import {pageDesignState} from './page-design.mjs';
import {navigationTexts,pageNeedsImage,designRulesFor} from './design-rules.mjs';
import {canonicalTexts} from './visual-model.mjs';
import {themeAssetForPage} from './theme-assets.mjs';
import {imageStyle,compactVisualText} from './image-prompts.mjs';
import {imageSizeText} from './image-space-budget.mjs';

export const imagePromptVersion='workflow-image-prompt-v28';
export const backgroundUse='使用随附原底图图生图，保持原底图颜色、结构、装饰和排布不变，在原底图基础上构建信息。';
const legacyBackgroundUse='随附底图作为锁定背景层，仅在其上新增文字、图片占位框及必要图形；不重绘、改色、移动或改变底图原有主体、纹理与构图。无字底图原样作为最终PPT页面背景。';
const role=n=>({title:'标题',subtitle:'副标题',body:'正文',caption:'图注',imageTitle:'图片标题',heading:'小标题',navigation:'页顶导航'}[n.role]||'正文');
const line=v=>String(v??'').replace(/\r?\n/g,' / ');
const aspect=e=>Number((e.aspect||e.w/e.h).toPrecision(3))+':1';
function progressImageInstruction(p,index,direction){
  const nav=navigationTexts(p,index);
  return nav.length?'页顶且仅一条'+(direction.presetDesign?'沿用预设的'+presetNavigation(direction):'粗分段进度条')+'，共'+nav.length+'段，按章节而非逐页设点；逐段写“'+nav.map(n=>n.text).join('”“')+'”；当前“'+nav.find(n=>n.current)?.text+'”加粗突出，其余段弱化。':'无进度条。';
}
function placeholderEmphasis(nodes,images){
  const ratios=images.map(e=>'“'+line(nodes.find(n=>n.id===e.nodeId)?.label||'配图')+'” '+aspect(e)).join('；');
  return images.length?{
    content:'图片占位比例（非上屏文案，宽:高）：'+ratios+'。',
    layout:'锁定图片占位框宽:高：'+ratios+'；不为适配分区拉伸、裁切或改变比例。',
  }:null;
}

export function slideImagePrompt(p,index,direction,images,mode='full'){
  const s=p.slides[index],d=pageDesignState(p,index),base=themeAssetForPage(p,index,direction.id);
  const nodes=orderedElements(initialElements(s)),nav=navigationTexts(p,index);
  const emphasis=placeholderEmphasis(nodes,images);
  // Geometry, font sizes and engineering IDs belong to local plans, never to the image brief.
  const names=new Map([...nodes.map(n=>[n.id,n.type==='text'?role(n):n.label]),...p.materials.map(m=>[m.id,m.name])]);
  const description=value=>{
    let text=line(value);
    for(const [id,name] of [...names].sort((a,b)=>b[0].length-a[0].length))text=text.replace(new RegExp('(?<![\\w-])'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\w-])','g'),'“'+line(name)+'”');
    return text.replace(/\b\d+(?:\.\d+)?\s*(?:pt|px|磅|像素)\b/gi,'').replace(/\b(?:x|y|w|h)\s*[:=]\s*\d+(?:\.\d+)?/gi,'').replace(/\b\d+\s*字(?:的|长)?/g,'').replace(/；\s*；/g,'；');
  };
  const anchors=nodes.filter(n=>n.type==='group'&&!nodes.some(parent=>parent.id===n.parentId&&parent.type==='group'));
  const layout=direction.presetDesign?'':anchors.slice(0,6).flatMap(n=>{
    const spec=d.plan.nodes.find(o=>o.id===n.id);
    const position=compactVisualText(description(spec?.position||''),25);
    return position?['  - “'+line(n.label)+'”：'+position+'。']:[];
  }).join('\n');
  const macro=compactVisualText(description(d.plan.layoutIntent||'').split(/[。；;]/)[0],40);
  const layoutSummary=(direction.presetDesign?'沿用所选预设的页型版式及承载，按当前内容数量排布；主标题统领全页，副标题附属于主标题，各段与各分点独立排布，不合入同一文本框，同级观点优先并列组合，保持内容树的从属、并列和顺序。在预设设计语言与已确认版式内发挥。':
    '主标题统领全页'+(nodes.some(n=>n.role==='subtitle')?'，副标题仅附属于主标题':'')+'；按内容树分组，各段与各分点独立排布，不合入同一文本框，同级观点优先并列组合，保持原有从属、并列和顺序。'+(anchors.length?'小标题紧邻所属正文，同组对齐。':'')+(macro?macro+'。':''));
  const pictures=images.map(e=>{
    const n=nodes.find(n=>n.id===e.nodeId),spec=d.plan.nodes.find(n=>n.id===e.nodeId);
    return `  - “${line(n?.label||'配图')}”：${direction.presetDesign?'按预设图文区放置':compactVisualText(description(spec?.position||'对应内容旁'),25)}，宽高比必须为 ${aspect(e)}${imageSizeText(e)?'，占位框尺寸约 '+imageSizeText(e)+'（1920×1080画布）':''}${nodes.some(c=>c.parentId===n?.id&&c.role==='imageTitle')?'，图片上方预留图片标题空间，字级与小标题区分':nodes.some(c=>c.parentId===n?.id&&c.role==='caption')?'，预留图注空间':''}。`;
  }).join('\n');
  const titlePage=s.kind==='cover'||s.kind==='toc',kind={cover:'标题页',toc:'目录页',section:'章节页',thanks:'致谢页'}[s.kind]||'内容页';
  const imageUse=base?'':pageNeedsImage(p,index)&&!images.length?'安排服务本页主题的非事实示意，与文字分开。':!images.length?'本页无配图，不增添插画。':'';
  return `- **比例要求**：${kind}，完整PowerPoint${mode==='concept'?'方向代表页':'整页预览'}，仅生成本页，16:9（1920×1080），无页面外框。
- **内容要求**：下列文案表达语义与体量，不新增事实或文案；嵌套子项从属于上级，同级正文分别作为独立分点，流程连接以本页箭头指令为准，副标题仅作标题附文。
${nestedContentList(nodes)}${emphasis?'\n  - '+emphasis.content:''}
- **排版要求**：${layoutSummary}
${layout}${emphasis?'\n  - '+emphasis.layout:''}
- **${titlePage?'底图与配图要求':'图片占位框比例'}**：${imageUse}${base?backgroundUse:''}${images.length?'每张登记原图仅画一个等比、平坦无字占位块，不重画事实内容；展示前本地贴回原件，完整保留主体、图例与标签。':''}
${pictures}
  - ${placeholderCountRule(images.length)}
- **风格要求**：${description(imageStyle(direction,{visualTreatment:p.visualTreatment,foundationLocked:!!base,use:s.kind==='cover'?'hero-image':s.kind==='toc'?'toc-image':'content-background'}))}。${nodes.some(n=>n.role==='imageTitle')?'图片标题仅作该图名称，紧邻图上方，字级或承载与分组小标题区分，不另加图注。':''}${direction.presetDesign?(p.visualTreatment==='flat'?'保持预设配色、框形与装饰设计，字体按简约要求，全套底色一致。':'保持预设原有配色、字形、框形与装饰设计，全套底色一致。'):''}${creativeStyleInstruction(d.plan,{preset:!!direction.presetDesign})}
- **进度条要求**：${progressImageInstruction(p,index,direction)}
- **视觉关系要求**：${visualConnectionInstruction(d.plan,nodes)}`.trim();
}

// User drafts and repairs keep their own complete brief, with a short execution boundary.
// Do not append the entire design/review policy to the drawing request.
export function effectiveSlideImagePrompt(p,index,direction,images,mode,override){
  if(!override)return slideImagePrompt(p,index,direction,images,mode);
  let brief=String(override).trim().replaceAll('\n  - '+imageCaptionRule,'').replaceAll('下方留图注空间','上方或下方留图注空间').replaceAll('\n'+designRulesFor(p,index,'image'),'')
    .replace(/\n*【占位框比例修正】[\s\S]*?【占位框比例修正结束】/g,'')
    .replace(/^(\s+- 锁定图片占位框宽:高：[^\n]*?)；只等比缩放，不为适配分区拉伸、裁切或改变比例。/gm,'$1；不为适配分区拉伸、裁切或改变比例。')
    .replaceAll(legacyBackgroundUse,'')
    .replaceAll('随附内容背景仅作风格参考，按需采用，正文和证据优先。','')
    .replaceAll('在随附对应内容底图上构建，延续核心底色、主题元素和阅读留白，正文和证据优先。','')
    .replaceAll('使用随附对应内容底图图生图，正文和证据优先。','')
    .replace(/使用随附原底图图生图，沿用[^\n]*?；不为底图加图注。/g,'')
    .replaceAll('必须在随附对应底图上构建本页，延续其主题主体、核心底色与阅读留白；使用图生图，不重新另起底图。','')
    .replaceAll('\n登记原图必须使用等比、无字的平坦占位块；不得生成原图内容。展示前由本地合成原图。','')
    .replaceAll('\n整页画布必须为16:9，1920×1080为优先目标，允许较小的16:9尺寸。','')
    .replace(/^- \*\*原图保真要求\*\*：[^\n]*\n?/gm,'')
    .replace(/\n【本次生成边界】[^\n]*/g,'');
  if(themeAssetForPage(p,index,direction.id)){
    const use=p.slides[index].kind==='cover'?'hero-image':p.slides[index].kind==='toc'?'toc-image':'content-background';
    brief=brief.replaceAll(imageStyle(direction,{visualTreatment:p.visualTreatment,use}),imageStyle(direction,{visualTreatment:p.visualTreatment,use,foundationLocked:true}));
  }
  brief=deduplicateSlidePrompt(simplifyPromptColors(brief));
  const nav=navigationTexts(p,index);
  const headers=[...brief.matchAll(/^- \*\*([^*]+)\*\*：/gm)],complete=headers.length===7&&['比例要求','内容要求','排版要求','风格要求','进度条要求','视觉关系要求'].every(name=>headers.some(h=>h[1]===name));
  if(complete){
    brief=brief.replace(/^- \*\*进度条要求\*\*：[^\n]*(?:\n(?!- \*\*)[^\n]*)*/m,'- **进度条要求**：'+progressImageInstruction(p,index,direction));
    brief=brief.replace(/^  - 页顶导航（独立于正文结构）：\r?\n(?:    - 页顶导航：[^\r\n]*(?:\r?\n|$))+/gm,'');
  }
  const additions=[];
  const supply=(section,text)=>{
    if(!complete){additions.push(text);return;}
    const all=[...brief.matchAll(/^- \*\*([^*]+)\*\*：/gm)],at=all.findIndex(h=>h[1]===section);
    if(at<0){additions.push(text);return;}
    const end=all[at+1]?.index??brief.length;
    brief=brief.slice(0,end).trimEnd()+'\n  - '+text+'\n'+brief.slice(end);
  };
  const plan=pageDesignState(p,index)?.plan||{},connection=visualConnectionInstruction(plan,orderedElements(initialElements(p.slides[index])));
  if(complete){
    const stylePart=brief.split('- **风格要求**：')[1]?.split(/\n- \*\*/)[0]||'';
    if(!/创意设计|创意方向/.test(stylePart))supply('风格要求',creativeStyleInstruction(plan,{preset:!!direction.presetDesign}));
    brief=brief.replace('图文对应所属分组，不新增因果箭头。','图文对应所属分组。');
    const relationPart=brief.split('- **视觉关系要求**：')[1]?.split(/\n- \*\*/)[0]||'';
    if(!arrowInstructionsOnly(relationPart))supply('视觉关系要求',connection);
  }
  if(!brief.includes('16:9')||!brief.includes('1920×1080'))supply('比例要求','画布16:9（1920×1080）。');
  if(!brief.includes(promptColor(direction.coreColor)))supply('风格要求',`页面可用颜色包含 ${promptColor(direction.coreColor)}。`);
  const imageSection=['cover','toc'].includes(p.slides[index].kind)?'底图与配图要求':'图片占位框比例';
  if(!brief.includes(placeholderCountRule(images.length)))supply(imageSection,placeholderCountRule(images.length));
  if(!brief.includes(backgroundUse)){
    brief=brief.replaceAll('无字底图原样作为最终PPT页面背景，保留主体位置、底色与纹理；文字及新增图形独立叠加，不覆盖全页。','');
    supply(imageSection,backgroundUse);
  }
  if(images.length){
    const nodes=orderedElements(initialElements(p.slides[index])),emphasis=placeholderEmphasis(nodes,images);
    if(complete){
      for(const [section,text] of [['内容要求',emphasis.content],['排版要求',emphasis.layout]]){
        const part=brief.split('- **'+section+'**：')[1]?.split(/\n- \*\*/)[0]||'';
        if(!part.includes(text))supply(section,text);
      }
      const part=brief.split('- **'+imageSection+'**：')[1]?.split(/\n- \*\*/)[0]||'';
      for(const e of images){
        const name=line(nodes.find(n=>n.id===e.nodeId)?.label||'配图');
        if(!part.split('\n').some(row=>row.includes('“'+name+'”')&&row.includes(aspect(e))))supply(imageSection,'“'+name+'”占位框宽:高必须为 '+aspect(e)+'，不得改变比例。');
        const size=imageSizeText(e);
        if(size){
          const headers=[...brief.matchAll(/^- \*\*([^*]+)\*\*：/gm)],at=headers.findIndex(h=>h[1]===imageSection),start=headers[at].index,end=headers[at+1]?.index??brief.length;
          const section=brief.slice(start,end).split('\n');let found=false;
          const updated=section.map(row=>{
            if(found||!row.includes('“'+name+'”'))return row;found=true;
            const clause='占位框尺寸约 '+size+'（1920×1080画布）';
            return /占位框尺寸约\s*\d+\s*[×x]\s*\d+\s*px(?:（1920×1080画布）)?/.test(row)?row.replace(/占位框尺寸约\s*\d+\s*[×x]\s*\d+\s*px(?:（1920×1080画布）)?/,clause):row.replace(/[。.]?$/, '，'+clause+'。');
          }).join('\n');
          brief=brief.slice(0,start)+updated+brief.slice(end);
        }
      }
    }
    if(!/(?:等比|宽高比)[^。\n]{0,35}占位|占位[^。\n]{0,35}(?:等比|宽高比)/.test(brief))supply(imageSection,'登记原图用等比、平坦无字占位块。');
    if(!/(?:不|禁止|不得).{0,6}(?:重画|重绘|生成).{0,12}(?:事实|原图|原件)|(?:原图|原件).{0,6}(?:不|禁止|不得).{0,6}(?:重画|重绘|生成)/.test(brief))supply(imageSection,'不重画事实内容。');
    if(!/(?:本地|展示前).{0,12}(?:贴回|回填|插回|插入).{0,8}(?:原件|原图)/.test(brief))supply(imageSection,'展示前本地贴回原件，保留主体、图例与标签。');
  }
  if(nav.length&&(!/页顶|顶部/.test(brief)||!nav.every(n=>brief.includes(n.text))))supply('进度条要求','页顶且仅一条粗分段进度条，共'+nav.length+'段，按章节而非逐页设点；逐段写“'+nav.map(n=>n.text).join('”“')+'”；当前“'+nav.find(n=>n.current)?.text+'”突出，其余段有色差。');
  if(!nav.length&&!brief.includes('无进度条'))supply('进度条要求','无进度条。');
  return deduplicateSlidePrompt(brief.trim()+(additions.length?'\n【本次生成边界】'+additions.join(''): ''));
}
