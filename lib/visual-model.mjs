import {formulaSVG} from './formula-native.mjs';
import {formulaLatex} from './formula-content.mjs';
import {normalizeCurvedArrow} from './curved-arrows.mjs';
import {normalizeDirectionalElement,normalizeDirectionalElements} from './directional-geometry.mjs';
import {colorAdjustmentSVG} from './color-adjustment.mjs';
import {visualGradient,gradientSVG} from './visual-gradient.mjs';
import {shapeGeometry,detailedShapePath} from './shape-geometry.mjs';
import {assertNativeCarriers} from './native-carriers.mjs';
import {nativeTextLines} from './native-text-lines.mjs';
import {nativeEffects,nativeEffectDefs,nativeLineAttributes,nativeTransform} from './native-effects.mjs';
import crypto from 'node:crypto';
import {visualColor,visualOpacity} from './visual-color.mjs';
import {normalizeSVGDataURL} from './svg-colors.mjs';
import {visualTextStyle} from './visual-text-style.mjs';
import {nativeShapeKinds,nativeShapeGeometry,validateCustomGeometry} from './native-shapes.mjs';
import {initialElements,orderedElements,tableCellTexts} from './elements.mjs';
import {annotateElements} from './element-classes.mjs';
import {normalizeTextPaint,styledTextLines} from './styled-text.mjs';
import {enforceTextPaintPolicy} from './text-style-policy.mjs';
import {pageDesignState,pageDesignStamp,projectLibraryVersions} from './page-design.mjs';
import {workflowManifest} from './workflow-library.mjs';
import {navigationTexts} from './design-rules.mjs';
import {themeAssetForPage} from './theme-assets.mjs';
import {expectedRebuildText} from './rebuild-text-parts.mjs';
import {imageMayStretch} from './image-geometry.mjs';
import {originalPage} from './ppt-visual-optimization.mjs';
import {joinedSegmentForExport} from './native-polylines.mjs';
import {footerPageElements,isFooterElement} from './footer-page-number.mjs';
import {hasInlineScript,layoutInlineLines,hasInlineMath,unicodeScriptKind} from '../public/inline-text.js';
import {formulaScriptCandidate} from './formula-script-fit.mjs';
import {scriptScale,scriptShift} from './script-metrics.mjs';
import {normalizeNativeAppearance} from './native-appearance-policy.mjs';
import {normalizeTableTypography} from './table-typography.mjs';
export const digest=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export const confirmedPages=p=>p.slides.map((s,i)=>i).filter(i=>pageDesignState(p,i)?.approvedCurrent);
export const pageStamp=(p,i,theme=p.selectedTheme,options={})=>digest({design:pageDesignStamp(p,i,options),markdown:pageDesignState(p,i)?.markdown,theme:p.concepts.find(c=>c.id===theme)?.style,styleRegistrationId:p.concepts.find(c=>c.id===theme)?.styleRegistrationId,themeAsset:themeAssetForPage(p,i,theme)?.previewHash});
export const fullPageCurrent=(p,i)=>!!p.visualPages?.[i]&&!!pageDesignState(p,i)?.approvedCurrent&&(p.visualPages[i].stamp===pageStamp(p,i)||[...new Set([...(workflowManifest.previousVersions||[]),...projectLibraryVersions(p)])].some(libraryVersion=>p.visualPages[i].stamp===pageStamp(p,i,p.selectedTheme,{libraryVersion})));
export const visualStamp=p=>digest({pages:p.slides.map((s,i)=>({stamp:fullPageCurrent(p,i)?p.visualPages[i].stamp:pageStamp(p,i),preview:p.visualPages?.[i]?.previewHash})),theme:p.selectedTheme});
export const rebuiltCurrent=p=>p.reconstruction?.mode==='free'&&p.reconstruction.stamp===visualStamp(p)&&p.reconstruction.slides.length===p.slides.length&&p.reconstruction.slides.every((page,i)=>{const base=themeAssetForPage(p,i,p.selectedTheme);return !base||(page.background?.id===base.materialId&&page.background?.sha256===base.previewHash);});
export const releaseCurrent=p=>!!p.output?.release?.passed&&p.output.version===p.version&&p.output.stamp===visualStamp(p)&&p.approvals.preview===p.version&&rebuiltCurrent(p);
export const canonicalTexts=(s,p,index)=>[...orderedElements(initialElements(s)).filter(n=>!(p&&originalPage(p,index)?.hiddenTitle&&n.role==='title')).flatMap(n=>n.type==='formula'?[{nodeId:n.id,text:n.latex,latex:n.latex,parentId:n.parentId,role:'formula',type:'formula'}]:n.type==='table'?tableCellTexts(n):(n.type==='text'&&n.text?.trim())||n.type==='group'?[{nodeId:n.id,text:n.type==='group'?n.label:n.text,parentId:n.parentId,role:n.type==='group'?'heading':n.role||'heading'}]:[]),...(p?navigationTexts(p,index):[])];
export const plannedImages=s=>orderedElements(initialElements(s)).filter(n=>n.type==='image'&&n.materialId).map(n=>({nodeId:n.id,id:n.materialId}));
export const canVisualOverflow=e=>!e?.managed&&(['rect','ellipse','shape','svg','line','cutout','generate','crop'].includes(e?.type)||e?.type==='image'&&!!e.implementation);
export function box(e,{allowOverflow=false}={}){const line=e?.type==='line';if(!e||!['x','y','w','h'].every(k=>typeof e[k]==='number'&&Number.isFinite(e[k]))||(line?e.w<0||e.h<0||e.w===0&&e.h===0:e.w<=0||e.h<=0)||!Number.isFinite(e.x+e.w)||!Number.isFinite(e.y+e.h)||(!allowOverflow&&(e.x<0||e.y<0||e.x+e.w>1600.1||e.y+e.h>900.1)))throw Error('视觉元素坐标或尺寸无效（1600×900画布；'+String(e?.key||e?.type||'未命名元素').slice(0,80)+'：x='+e?.x+'，y='+e?.y+'，w='+e?.w+'，h='+e?.h+'；'+(allowOverflow?'图形允许出画布，须保留完整有限坐标与正尺寸':'须满足0≤x、0≤y、x+w≤1600、y+h≤900')+'，水平/竖直line允许单轴为0）');return {x:e.x,y:e.y,w:e.w,h:e.h};}
export function validateImagePlan(raw,s){const images=plannedImages(s);if(!Array.isArray(raw)||raw.length!==images.length||new Set(raw.map(e=>e.nodeId)).size!==images.length)throw Error('图片计划必须包含所有已登记图片节点');const result=raw.map(e=>{const source=images.find(n=>n.nodeId===e.nodeId);if(!source||source.id!==e.id)throw Error('图片计划不得替换材料身份');return {...source,...box(e)};});if(!s.sourcePresentation&&result.some((e,i)=>result.slice(i+1).some(other=>overlaps(e,other)>0)))throw Error('登记图片预留区不能相互覆盖');return result;}
function overlaps(a,b){return Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));}
export function validateAudit(raw,s,imagePlan,p,index,{requireSeparatedNumbers=true,allowPartial=false,artisticAssets=[]}={}){
  if(!Array.isArray(raw)||raw.length<1||raw.length>220)throw Error('元素审计须返回 1–220 个独立元素');
  assertNativeCarriers(raw);
  const keys=new Set(),textMap=new Map(),images=new Set(),allowed=new Set(['text','formula','rect','ellipse','line','shape','svg','crop','generate','cutout','image']);
  const result=normalizeDirectionalElements(raw).map(rawElement=>{
    const e=normalizeNativeAppearance(normalizeCurvedArrow(normalizeDirectionalElement(rawElement)));
    if(typeof e.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(e.key)||keys.has(e.key)||!allowed.has(e.type))throw Error('元素编号重复或类型无效');keys.add(e.key);
    const out={key:e.key,type:e.type,...box(e,{allowOverflow:canVisualOverflow(e)}),description:String(e.description||'').slice(0,700)};
    if(isFooterElement(e)){
      const expected=footerPageElements(p,index).find(n=>n.key===e.key);
      if(!expected||Object.entries(expected).some(([k,v])=>JSON.stringify(e[k])!==JSON.stringify(v)))throw Error('页脚页码由05统一生成，不能单独改写或修改样式');
      return structuredClone(expected);
    }
    if(e.type==='formula'){
      const n=canonicalTexts(s,p,index).find(n=>n.nodeId===e.nodeId&&n.role==='formula');
      const source=e.sourceLatex?formulaLatex(e.sourceLatex):null,candidate=source?formulaScriptCandidate(source):null;
      const scriptCorrection=source===n?.latex&&candidate?.correctedLatex===formulaLatex(e.latex||e.text)
        &&e.formulaScriptEvidence?.changed===true&&['reference','user-request'].includes(e.formulaScriptEvidence?.policy);
      if(!n||!scriptCorrection&&formulaLatex(e.latex||e.text)!==n.latex||textMap.has(n.nodeId))throw Error('原生公式须保留内容树中的准确公式，每项只重建一次');
      textMap.set(n.nodeId,new Set(['whole']));
      Object.assign(out,{nodeId:n.nodeId,role:'formula',latex:scriptCorrection?e.latex:n.latex,
        ...(scriptCorrection?{sourceLatex:source,formulaScriptEvidence:structuredClone(e.formulaScriptEvidence)}:{}),
        size:Math.max(12,Math.min(120,Number(e.size)||32)),color:visualColor(e.color,'272727',{key:e.key,field:'color'}).color,align:['left','center','right'].includes(e.align)?e.align:'left'});
    }else if(e.type==='text'){
      if(canonicalTexts(s,p,index).some(n=>n.nodeId===e.nodeId&&n.role==='formula'))throw Error('公式必须使用type=formula原生公式，不能还原为普通文字');
      let expectation;try{expectation=expectedRebuildText(e,canonicalTexts(s,p,index),p,index,{requireSeparatedNumbers});}catch(error){throw Error(`必须逐条保留准确文字与小标题，不得改写、合并或遗漏（元素 ${e.key} · nodeId ${String(e.nodeId).slice(0,80)} · ${error.message}）`);}
      const {node:n,text,part,synthetic}=expectation,parts=textMap.get(n.nodeId)||new Set();if(e.text!==text||parts.has(part)||parts.has('whole')||part==='whole'&&parts.size)throw Error(`必须逐条保留准确文字与小标题，不得改写、合并或遗漏（元素 ${e.key} · nodeId ${n.nodeId} · ${parts.has(part)?'节点重复':'文字与准确文案不一致'}）`);parts.add(part);textMap.set(n.nodeId,parts);
      if(n.role==='navigation'&&e.y+e.h>Math.max(100,(p?.rebuildPresentation?.progress?.y||0)+(p?.rebuildPresentation?.progress?.h||0)+4))throw Error('章节进度导航必须保留在页面顶部');
      const style=visualTextStyle(e,n.role),ink=visualColor(e.color,'272727',{key:e.key,field:'color'});Object.assign(out,{nodeId:n.nodeId,role:n.role,text,...style,color:ink.color,align:['left','center','right'].includes(e.align)?e.align:'left'});if(part!=='whole')Object.assign(out,{part,sourceText:n.text});if(synthetic){Object.assign(out,{role:n.role,forNodeId:e.forNodeId});if(n.role==='visual-number')Object.assign(out,{numberKind:'ordinal',sourceBox:box({...e.sourceBox,key:e.key+':sourceBox',type:'rect'})});}if(ink.alpha!==1||e.opacity!==undefined)out.opacity=ink.alpha*visualOpacity(e.opacity);
    }else if(e.type==='image'&&e.artisticText===true){
      const n=canonicalTexts(s,p,index).find(n=>n.nodeId===e.nodeId),authorized=[...(p?.materials||[]),...artisticAssets].some(m=>m.id===e.id&&m.artisticText===true&&m.nodeId===e.nodeId&&m.text===e.text);
      if(!authorized||e.implementation!=='cutout'||!n||n.role==='navigation'||e.text!==n.text||textMap.has(n.nodeId))throw Error('书法字抠图必须由用户指定并保留准确文字，不能重复或替换其他节点');
      textMap.set(n.nodeId,new Set(['whole']));Object.assign(out,{id:e.id,nodeId:e.nodeId,text:e.text,artisticText:true,implementation:'cutout'});
      if(e.sourceBox)out.sourceBox=box({...e.sourceBox,type:'rect',key:e.key+':sourceBox'});
    }else if(e.type==='image'){
      const plan=imagePlan.find(n=>n.nodeId===e.nodeId);if(!plan||plan.id!==e.id||images.has(plan.nodeId))throw Error('必须使用图片计划中的登记原件');
      if(['x','y','w','h'].some(k=>Math.abs(e[k]-plan[k])>1))throw Error('原图位置须保持批准后的图片计划');images.add(plan.nodeId);Object.assign(out,{id:plan.id,nodeId:plan.nodeId,...box(plan)});
      if(imageMayStretch(plan))Object.assign(out,{imageFit:'fill',aspect:plan.aspect,aspectAdjustment:Math.abs(plan.w/plan.h/plan.aspect-1)});
    }else if(['rect','ellipse','line','shape'].includes(e.type)){if(e.type==='shape'){if(!nativeShapeKinds.includes(e.shape))throw Error('不支持的原生图形，请用登记的shape类型或SVG');out.shape=e.shape;}const fill=visualColor(e.fill,'EEEEEE',{key:e.key,field:'fill'}),ink=visualColor(e.color,e.fill??'272727',{key:e.key,field:'color'});out.fill=fill.color;out.color=ink.color;out.strokeWidth=Number(e.strokeWidth??(e.type==='line'?1:0));if(!Number.isFinite(out.strokeWidth)||out.strokeWidth<0||out.strokeWidth>20)throw Error('线宽无效');out.opacity=visualOpacity(e.opacity??1);const fillAlpha=fill.alpha*visualOpacity(e.fillOpacity??1),colorAlpha=ink.alpha*visualOpacity(e.colorOpacity??1);if(fillAlpha!==1)out.fillOpacity=fillAlpha;if(colorAlpha!==1)out.colorOpacity=colorAlpha;}
    else if(e.type==='svg'){if(typeof e.svg!=='string'||e.svg.length>180000)throw Error('缺少局部 SVG');out.svg=e.svg;if(e.curveArrow)out.curveArrow=e.curveArrow;}
    else if(e.type==='crop'||e.type==='cutout'){
      out.sourceBox=box({...e.sourceBox,key:e.key+':sourceBox',type:'rect'});if(out.sourceBox.w*out.sourceBox.h>1600*900*.35)throw Error('禁止把整页底稿或大面积排版裁成图片');
      if(e.mask!==undefined){if(!Array.isArray(e.mask)||e.mask.length<3||e.mask.length>200||e.mask.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1)))throw Error('局部素材轮廓无效');out.mask=e.mask;}
      if(e.type==='cutout'){if(e.nonFactual!==true)throw Error('本地背景分离仅限独立非事实视觉元素，材料图片须直接使用登记原件');if(e.prompt!==undefined&&(typeof e.prompt!=='string'||e.prompt.length>6000))throw Error('局部提取说明格式无效');if(e.prompt)out.prompt=e.prompt;out.nonFactual=true;}
    }else if(e.type==='generate'){if(typeof e.prompt!=='string'||e.prompt.trim().length<10||e.prompt.length>6000||e.nonFactual!==true)throw Error('新增生图素材仅限非事实装饰，并须提供提示词');out.prompt=e.prompt;out.nonFactual=true;}
    if(e.gradient!==undefined&&e.gradient!==null){
      if(!['text','rect','ellipse','shape','line'].includes(e.type))throw Error('仅文字、原生色块和线条可使用gradient，其他复杂元素按原方法重建');
      out.gradient=visualGradient(e.gradient,{key:e.key});
      if(e.type==='text'){out.color=out.gradient.stops[0].color;out.opacity=visualOpacity(e.opacity);}
      else if(e.type==='line'){out.color=out.gradient.stops[0].color;out.colorOpacity=1;}
      else{out.fill=out.gradient.stops[0].color;out.fillOpacity=visualOpacity(e.fillOpacity);}
    }
    if(e.type==='text'){
      const spans=values=>Array.isArray(values)?values.slice(0,80).filter(span=>Number.isInteger(span.lineIndex)&&span.lineIndex>=0
        &&Number.isFinite(span.startFraction)&&Number.isFinite(span.endFraction)&&span.startFraction>=0
        &&span.endFraction<=1&&span.endFraction>span.startFraction).map(span=>({lineIndex:span.lineIndex,startFraction:span.startFraction,endFraction:span.endFraction})):[];
      if(Array.isArray(e.textColorRuns))out.textColorRuns=e.textColorRuns.slice(0,10).map(run=>({color:visualColor(run.color,out.color,{key:e.key}).color,
        lineSpans:spans(run.lineSpans),...(Number.isFinite(run.startLine)&&Number.isFinite(run.endLine)?{startLine:run.startLine,endLine:run.endLine}:{})}));
      if(Array.isArray(e.boldRuns))out.boldRuns=spans(e.boldRuns);
    }
    if(e.customGeometry){if(e.type!=='shape')throw Error('自定义轮廓仅适用于原生shape');out.customGeometry=validateCustomGeometry(e.customGeometry);}
    if(e.shapeGeometry!=null){if(!['shape','rect','ellipse'].includes(e.type))throw Error('形状细节只适用于原生几何');out.shapeGeometry=shapeGeometry(e.shapeGeometry);if(out.shapeGeometry.corners&&!e.customGeometry)detailedShapePath({...e,shapeGeometry:out.shapeGeometry});}
    if(e.strokeGradient!=null){if(!['shape','rect','ellipse','line'].includes(e.type))throw Error('描边渐变只适用于原生几何和线条');out.strokeGradient=visualGradient(e.strokeGradient,{key:e.key});out.color=out.strokeGradient.stops[0].color;}
    if(e.baseGeometry&&typeof e.baseGeometry.kind==='string')out.baseGeometry={kind:e.baseGeometry.kind.slice(0,40),confidence:Number(e.baseGeometry.confidence)||0};
    if(typeof e.class==='string'&&/^[a-zA-Z-]{2,40}$/.test(e.class))out.class=e.class;
    if(['solid','gradient','translucent','image','none'].includes(e.fillKind))out.fillKind=e.fillKind;
    if(['stroke','noStroke','glowOnly','unknown'].includes(e.strokeKind))out.strokeKind=e.strokeKind;
    if(['crisp','faint','softGlow','unknown'].includes(e.edgeKind))out.edgeKind=e.edgeKind;
    if(e.fitIgnore===true)out.fitIgnore=true;
    if(e.shape==='freeform'&&!out.customGeometry)throw Error('原生异形缺少实际轮廓');
    Object.assign(out,nativeEffects({...e,role:out.role||e.role}));
    if(e.type==='text'&&e.noWrap===true)out.noWrap=true;
    return out;
  });
  // Preserve staged-lock / paint-provenance fields that the audit does not validate directly but
  // later stages rely on (table grid locks, measured fill provenance, staged markers).
  const rawByKey = new Map((raw || []).map(element => [element?.key, element]));
  const preservedFields = ['keepParameters', 'tablePlaced', 'tableRole', '_tableStage',
    'fillSource', 'themeFillMerged', 'cornerInfo', 'tableGridExtra',
    'tableId', 'tableGroup', 'tableObject', 'tableFittedFill','parentKey','memberKeys',
    'geometryEvidence','geometryConfidence','lowConfidenceGeometry','lowConfidenceReason','shapeRepaired','textPaintMeasured','textColorKind',
    'rowIndex','tableRowKey','tableColorGroup','tablePaintEvidence','paintConsensus','parameterEvidence','tableAlignment','tableTypography','fillEndAlphaEvidence','edgeHighlight','objectIdentity','polylineId','representationGroup','representationOrigin'];
  for (const element of result) {
    const sourceElement = rawByKey.get(element?.key);
    if (!sourceElement) continue;
    for (const field of preservedFields) {
      if (sourceElement[field] !== undefined) element[field] = sourceElement[field];
    }
  }

  const missingTexts=canonicalTexts(s,p,index).filter(n=>{const parts=textMap.get(n.nodeId);return !parts||!parts.has('whole')&&!(parts.has('label')&&(parts.has('number')||parts.has('body')));}),missingImages=imagePlan.filter(n=>!images.has(n.nodeId));if(!allowPartial&&(missingTexts.length||missingImages.length))throw Error('审计遗漏准确文字、小标题、页顶导航或登记原图：'+[...missingTexts,...missingImages].map(n=>n.nodeId).join('、'));
  const protectedAreas=result.filter(e=>['text','formula','image'].includes(e.type));
  const cropConflicts=result.filter(e=>e.type==='crop'||e.type==='cutout').flatMap(e=>protectedAreas.filter(a=>overlaps(e.sourceBox,a)>0).map(a=>({element:e.key,sourceBox:e.sourceBox,protectedElement:a.key,protectedType:a.type,protectedBox:{x:a.x,y:a.y,w:a.w,h:a.h}})));
  if(cropConflicts.length)throw Error('局部裁剪不能包含文字、图表或登记原图区域；请缩小或移动sourceBox以避开列出的区域，无法避开时改用 SVG 重绘。冲突：'+JSON.stringify(cropConflicts.slice(0,12)));
  return annotateElements(normalizeTableTypography(result.map(enforceTextPaintPolicy)).elements);
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Each line gets an absolute baseline; every run uses its own absolute y, so sup/sub
// offsets never accumulate across runs and line wrapping cannot shift later lines.
function inlineSVGText(e,lines,startX,firstBaseline,lineAdvance){
  return lines.map((runs,lineIndex)=>{
    const baseline=firstBaseline+lineIndex*lineAdvance;
    let content='',first=true;
    for(const run of runs){
      const shift=run.script?-e.size*scriptShift[run.script]:0,size=run.script?e.size*scriptScale:e.size;
      content+=`<tspan${first?` x="${startX}"`:''} y="${baseline+shift}" font-size="${size}">${esc(run.text)}</tspan>`;
      first=false;
    }
    return content;
  }).join('');
}

function textGradientSVG(gradient,id){
  const stops=(gradient.stops||[]).map(stop=>`<stop offset="${stop.offset??0}" stop-color="#${stop.color}"/>`).join('');
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>`;
}
function styledRunSegments(e, lineText, lineIndex, lineCount) {
  const base = String(e.color || '000000');
  const length = Math.max(1, lineText.length);
  const colourRuns = Array.isArray(e.textColorRuns) ? e.textColorRuns : [];
  const boldRuns = Array.isArray(e.boldRuns) ? e.boldRuns : [];
  const colourSpans = colourRuns.flatMap(run => (run.lineSpans || [])
    .filter(span => Number(span.lineIndex) === lineIndex)
    .map(span => ({start: Math.min(length, Math.max(0, Math.round(Number(span.startFraction) * length))),
      end: Math.min(length, Math.round(Number(span.endFraction) * length)), color: run.color})))
    .filter(span => span.end > span.start);
  const boldSpans = boldRuns
    .filter(span => Number(span.lineIndex) === lineIndex)
    .map(span => ({start: Math.min(length, Math.max(0, Math.round(Number(span.startFraction) * length))),
      end: Math.min(length, Math.round(Number(span.endFraction) * length))}))
    .filter(span => span.end > span.start);
  if (!colourSpans.length && !boldSpans.length) return [{text: lineText, color: base, bold: false}];
  const boundaries = new Set([0, length]);
  for (const span of [...colourSpans, ...boldSpans]) { boundaries.add(span.start); boundaries.add(span.end); }
  const points = [...boundaries].sort((a, b) => a - b);
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index], end = points[index + 1];
    if (end <= start) continue;
    const middle = (start + end) / 2;
    const colour = colourSpans.find(span => middle >= span.start && middle < span.end);
    const bold = boldSpans.some(span => middle >= span.start && middle < span.end) || Boolean(e.bold);
    segments.push({text: lineText.slice(start, end), color: colour ? colour.color : base, bold});
  }
  const merged = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.color === segment.color && last.bold === segment.bold) last.text += segment.text;
    else merged.push({...segment});
  }
  return merged;
}

function textColourRunSegments(e,lineText,lineIndex,lineCount){
  const base=String(e.color||'000000');
  const runs=Array.isArray(e.textColorRuns)?e.textColorRuns:[];
  if(!runs.length)return [{text:lineText,color:base}];
  const spans=runs.flatMap(run=>(run.lineSpans||[])
    .filter(span=>Number(span.lineIndex)===lineIndex)
    .map(span=>({...span,color:run.color})))
    .sort((a,b)=>Number(a.startFraction)-Number(b.startFraction));
  if(spans.length){
    const length=Math.max(1,lineText.length);const segments=[];let cursor=0;
    for(const span of spans){
      const start=Math.min(length,Math.max(cursor,Math.round(Number(span.startFraction)*length)));
      const end=Math.min(length,Math.max(start+1,Math.round(Number(span.endFraction)*length)));
      if(start>cursor)segments.push({text:lineText.slice(cursor,start),color:base});
      segments.push({text:lineText.slice(start,end),color:span.color});
      cursor=Math.max(cursor,end);
    }
    if(cursor<length)segments.push({text:lineText.slice(cursor),color:base});
    return segments;
  }
  const middle=(lineIndex+0.5)/Math.max(1,lineCount);
  const lineRun=runs.find(run=>middle>=Number(run.startLine??1)-1e-6&&middle<=Number(run.endLine??0)+1e-6);
  return [{text:lineText,color:lineRun?lineRun.color:base}];
}

function plainSVGText(lines,startX,lineAdvance){
  return lines.map((runs,lineIndex)=>`<tspan x="${startX}" dy="${lineIndex?lineAdvance:0}">${esc(runs.map(run=>run.text).join(''))}</tspan>`).join('');
}
export function nativeSVG(elements,imageURL,background){
  const assetURL=id=>normalizeSVGDataURL(imageURL(id));
  elements=normalizeTableTypography(normalizeDirectionalElements(elements).map(normalizeTextPaint).map(normalizeNativeAppearance)).elements;
  elements=elements.map(e=>joinedSegmentForExport(e,{elements}));
  const defs=elements.map((e,i)=>(e.gradient?gradientSVG(e.gradient,'native-gradient-'+i,e):'')+(e.strokeGradient?gradientSVG(e.strokeGradient,'native-stroke-gradient-'+i,e):'')+(e.type==='text'&&e.textGradient?textGradientSVG(e.textGradient,'native-text-gradient-'+i):'')+nativeEffectDefs(e,i)+colorAdjustmentSVG(e.type==='image'&&e.implementation==='cutout'?e.colorAdjustment:undefined,'native-color-'+i)).join('')+colorAdjustmentSVG(background?.colorAdjustment,'native-background-color');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1600 900">${defs?'<defs>'+defs+'</defs>':''}${background?`<image href="${esc(assetURL(background.id))}" x="0" y="0" width="1600" height="900" preserveAspectRatio="none"${background.colorAdjustment?' filter="url(#native-background-color)"':''}/>`:''}${elements.map((e,i)=>{
    const fill=e.type==='text'&&e.textGradient?'url(#native-text-gradient-'+i+')':e.gradient?'url(#native-gradient-'+i+')':'#'+(e.type==='text'?e.color:e.fill),transform=nativeTransform(e.type==='line'&&e.objectIdentity?.component?.kind==='native-polyline'?{...e,flipH:false,flipV:false}:e);
    let content;
    if(e.type==='formula')content=formulaSVG(e);
    else if(e.type==='text'){
      const singleLine=e.noWrap||e.role==='navigation';
      const source=singleLine?String(e.text).replace(/\s*\n\s*/g,' '):e.text,scriptText=hasInlineScript(source);
      const lines=scriptText?layoutInlineLines(source,{width:singleLine?Infinity:e.w,measure:(char,first)=>(char.codePointAt(0)>255?e.size:e.size*.57)+(first?0:(e.charSpacing??0))}):nativeTextLines(source,singleLine?Infinity:e.w,e.size,e.charSpacing??0).map(text=>[{text,script:null}]);
      const tx=e.x+(e.align==='center'?e.w/2:e.align==='right'?e.w:0),ty=e.valign==='mid'?e.y+(e.h-(e.size+Math.max(0,lines.length-1)*(e.lineSpacing??e.size*1.2)))/2+e.size:e.y+e.size,lineAdvance=e.lineSpacing??e.size*1.2;
      const styledRuns=(Array.isArray(e.textColorRuns)&&e.textColorRuns.length)
        ||(Array.isArray(e.boldRuns)&&e.boldRuns.length)||hasInlineMath(source)
        ||[...String(source)].some(unicodeScriptKind);
      let inlineMath='';
      const inner=styledRuns?styledTextLines(e).map((units,lineIndex)=>{
        const total=units.reduce((sum,unit)=>sum+unit.advance,0);
        let x=tx-(e.align==='center'?total/2:e.align==='right'?total:0);
        return units.map(unit=>{
          const shift=unit.script?-e.size*scriptShift[unit.script]:0;
          const y=ty+lineIndex*lineAdvance+shift;
          const at=x;x+=unit.advance;
          if(unit.type==='math'){
            inlineMath+=formulaSVG({...e,latex:unit.latex,color:unit.color,x:at,y:y-e.size,w:unit.advance,h:e.size*1.3,align:'left'});
            return '';
          }
          return `<tspan x="${at}" y="${y}" font-size="${unit.script?e.size*scriptScale:e.size}" fill="${e.gradient?fill:'#'+unit.color}" font-weight="${unit.bold?700:400}">${esc(unit.text)}</tspan>`;
        }).join('');
      }).join(''):(scriptText?inlineSVGText(e,lines,tx,ty,lineAdvance):plainSVGText(lines,tx,lineAdvance));
      content=`<text x="${tx}" y="${ty}" font-family="${esc(e.fontFace||'Microsoft YaHei')}" font-style="${e.italic?'italic':'normal'}" font-size="${e.size}" letter-spacing="${e.charSpacing??0}" font-weight="${e.bold?700:400}" fill="${fill}"${e.outline?` stroke="#${e.outline.color}" stroke-width="${e.outline.width}" stroke-opacity="${e.outline.opacity}" stroke-linejoin="round" paint-order="stroke fill"`:''}${e.shadow?` filter="url(#native-shadow-${i})"`:''} opacity="${e.opacity??1}" text-anchor="${styledRuns?'start':e.align==='center'?'middle':e.align==='right'?'end':'start'}">${inner}</text>`+inlineMath;
    }else if(['rect','ellipse','shape'].includes(e.type)){
      const geometry=e.type==='rect'&&!e.shapeGeometry?`rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}"`:e.type==='ellipse'?`ellipse cx="${e.x+e.w/2}" cy="${e.y+e.h/2}" rx="${e.w/2}" ry="${e.h/2}"`:nativeShapeGeometry(e);
      content=`<${geometry} fill="${fill}" fill-opacity="${e.fillOpacity??1}" stroke="${e.strokeGradient?'url(#native-stroke-gradient-'+i+')':'#'+(e.color??e.fill)}" stroke-width="${e.strokeWidth??0}" stroke-opacity="${e.colorOpacity??1}" opacity="${e.opacity??1}"${nativeLineAttributes(e,i)}/>`;
    }else if(e.type==='line'){
      const lx1=e.flipH?e.x+e.w:e.x,ly1=e.flipV?e.y+e.h:e.y,lx2=e.flipH?e.x:e.x+e.w,ly2=e.flipV?e.y:e.y+e.h;
      let lineAttrs=nativeLineAttributes(e,i);
      if(e.flipH!==e.flipV&&/marker-start="[^"]*"/.test(lineAttrs)&&/marker-end="[^"]*"/.test(lineAttrs))
        lineAttrs=lineAttrs.replace(/marker-start="([^"]*)"([^>]*?)marker-end="([^"]*)"/,`marker-start="$3"$2marker-end="$1"`);
      content=`<line x1="${lx1}" y1="${ly1}" x2="${lx2}" y2="${ly2}" stroke="${e.strokeGradient?'url(#native-stroke-gradient-'+i+')':e.gradient?'url(#native-gradient-'+i+')':'#'+e.color}" stroke-width="${e.strokeWidth}" stroke-opacity="${e.colorOpacity??1}" opacity="${e.opacity??1}"${lineAttrs}/>`;
    }
    else content=`<image href="${esc(assetURL(e.id))}" x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" preserveAspectRatio="${imageMayStretch(e)?'none':'xMidYMid meet'}"/>`;
    if(e.type!=='text'&&e.shadow)content=`<g filter="url(#native-shadow-${i})">${content}</g>`;
    if(e.type==='image'&&e.implementation==='cutout'&&e.colorAdjustment)content=`<g filter="url(#native-color-${i})">${content}</g>`;
    return transform?`<g transform="${transform}">${content}</g>`:content;
  }).join('')}</svg>`;
}
