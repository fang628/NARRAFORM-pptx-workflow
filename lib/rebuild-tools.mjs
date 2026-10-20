import {normalizeCurvedArrow} from './curved-arrows.mjs';
import {normalizeDirectionalElement} from './directional-geometry.mjs';
import {localCutoutPlacement} from './cutout-fallback.mjs';
import {assetServiceUnavailable,stopAssetTool} from './errors.mjs';
import {automaticArtisticTarget} from './artistic-text.mjs';
import {deckTitleFontRule} from './title-fonts.mjs';
import {colorAdjustmentRule} from './color-adjustment.mjs';
import {textSpacingRule} from './text-spacing.mjs';
import {prepareElementFonts} from './automatic-fonts.mjs';
import {availableNativeFonts,nativeFontContext,artisticFontRule} from './native-fonts.mjs';
import {insertedInstanceManifest,rebuildReuseRule} from './rebuild-reuse.mjs';
import {validateAudit,canonicalTexts,box,nativeSVG,digest,visualStamp} from './visual-model.mjs';
import {nativeShapeKinds} from './native-shapes.mjs';
import {runModelTools} from './model-tools.mjs';
import {rebuildMethodRule,validateRebuildMethods} from './rebuild-methods.mjs';
import {isDeepStrictEqual} from 'node:util';
import {validateExtractionScope} from './rebuild-region.mjs';
import {expectedRebuildText,rebuildAppearanceRule,rebuildNumberRule,auditNumberInventory} from './rebuild-text-parts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {publishRebuildAssets} from './rebuild-output.mjs';

const tool=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const rebuildTools=[
  tool('inspect_page','读取当前页准确内容、所有独立对象、问题和固定底图。'),
  tool('reuse_visual_asset','复用inspect_page返回的已有重建素材，不重新抠图或生成。仅当外观一致时使用；每个实例保留独立key和位置大小，不修改素材原件或其他实例。',{assetId:{type:'string'},key:{type:'string'},x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'},description:{type:'string'}},['assetId','key','x','y','w','h']),
  tool('apply_page_patch','修改本页对象坐标、字号size、字体fontFace、字距charSpacing与行距lineSpacing（逻辑单位）、饱和度和明度colorAdjustment、bold/italic、颜色、填充、线宽及层级；outline:{color,width,opacity}和shadow:{type,color,opacity,blur,offset,angle}保留文字描边与阴影，传null删除；dashType、beginArrowType/endArrowType保留线条虚实、箭头或圆点oval端点，flipH/flipV保留方向；直线可直接用start/end登记实际两端，箭形用arrowDirection及arrowTail:flat/notched/shaft，内凹尾不能还原为六边形。gradient可设置文字、色块、箭形或线条的原生渐变，传null恢复纯色。有框文字的承载单独用原生shape/rect或SVG，无框文字不新增承载；补回底图未含的色块。可新增原生图形及遗漏数字text；新增文字须对应准确内容或预览序号，不能改写已有文字、替换材料身份或删除文字和原图。',{edits:{type:'array',items:{type:'object',properties:{key:{type:'string'},properties:{type:'object'}},required:['key','properties']}},add:{type:'array',items:{type:'object'}},remove:{type:'array',items:{type:'string'}},order:{type:'array',items:{type:'string'}}}),
  tool('create_visual_asset','复杂几何形状与简单平面图标用svg重绘；弧线箭头优先给curveArrow，明确headAt及startDirection/endDirection，程序沿端点切线生成尖端，朝向不符拒绝本次工具参数并反馈修正；复杂现实风格图标和复杂画面元素用cutout附局部参考图进行图生图抠图，输出透明独立素材。简单色块与线条用apply_page_patch新增PPT原生图形。统一框选自动判断目标；若为书法/艺术字，contentType=artistic_text、method=cutout，textKey由模型根据预览与候选文字自动识别，成功后自动替换对应原生文字，不向用户询问编号。成功后自动加入本页，可删除旧装饰。',{method:{type:'string',enum:['svg','cutout']},contentType:{type:'string',enum:['visual','artistic_text']},textKey:{type:'string',description:'仅书法字抠图，由模型从inspect_page.artisticTextCandidates识别对应key；用户无需填写'},key:{type:'string'},x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'},svg:{type:'string'},curveArrow:{type:'object',description:'弧线起止点、控制点、headAt及对应端方向，程序沿端点切线生成箭头轮廓'},prompt:{type:'string'},sourceBox:{type:'object',properties:{x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'}},required:['x','y','w','h']},description:{type:'string'}},['method','key','x','y','w','h']),
  tool('render_page','渲染当前独立元素场景以复看布局，返回图像。最终仍必须用真实PowerPoint渲染复查。')
];
const editable=new Set(['x','y','w','h','size','fontFace','charSpacing','lineSpacing','colorAdjustment','italic','bold','align','color','fill','opacity','fillOpacity','colorOpacity','strokeWidth','shape','gradient','fontCategory','outline','shadow','dashType','beginArrowType','endArrowType','flipH','flipV','rotate','adjustments','start','end','arrowDirection','arrowTail']);
const overlaps=(a,b)=>Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x)&&Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y);
export function assertSingleElementEdit(elements,originalPage,targetKey){
  if(!targetKey)return;
  if(!originalPage.elements.some(e=>e.key===targetKey))throw Error('指定元素不存在');
  if(elements.length!==originalPage.elements.length||elements.some((e,i)=>e.key!==originalPage.elements[i].key||e.key!==targetKey&&!isDeepStrictEqual(e,originalPage.elements[i])))throw Error('单元素修改只能修改指定元素，不能增删、重排或修改其他元素');
}
export function safeDecorationCrop(sourceBox,page,artisticText){
  const crop=box(sourceBox);if(crop.w*crop.h>1600*900*.35)throw Error('只允许抠取独立局部装饰，不允许整页或大块布局');
  if(page.elements.filter(e=>e.type==='text'&&!(artisticText&&e.nodeId===artisticText.nodeId&&e.text===artisticText.text)||(e.type==='image'&&!e.implementation)).some(e=>overlaps(crop,e)))throw Error('抠图区域不得包含文字、图表或登记原图');
  return crop;
}
export function validateRebuiltScene(elements,{slide,project,index,originalPage,assets,targetKey,regionScope}){
  elements=elements.map(normalizeDirectionalElement);
  assertSingleElementEdit(elements,originalPage,targetKey);
  validateExtractionScope(elements,regionScope);
  const protectedText=new Map(canonicalTexts(slide,project,index).map(n=>[n.nodeId,n.text])),factImages=originalPage.elements.filter(e=>e.type==='image'&&!e.implementation),knownAssets=new Set(assets.map(m=>m.id));
  for(const e of elements){
    if(e.colorAdjustment&&!(e.type==='image'&&e.implementation==='cutout'))throw Error('颜色微调仅适用于AI抠图元素，原图、文字和原生色块保持原样');
    if(e.type==='text'&&expectedRebuildText(e,canonicalTexts(slide,project,index),project,index,{requireSeparatedNumbers:false}).text!==e.text)throw Error('工具不得修改准确文案或文字身份');
    if(e.type==='image'&&!e.implementation&&!factImages.some(n=>n.nodeId===e.nodeId&&n.id===e.id))throw Error('工具不得替换登记原图');
    if(e.type==='image'&&e.implementation&&!knownAssets.has(e.id))throw Error('重建素材必须通过工具登记');
    for(const k of ['fillOpacity','colorOpacity'])if(e[k]!==undefined&&(!Number.isFinite(e[k])||e[k]<0||e[k]>1))throw Error('透明度必须为0–1');
  }
  const images=factImages.map(e=>{const changed=elements.find(n=>n.type==='image'&&!n.implementation&&n.nodeId===e.nodeId);return {...e,...(changed?box(changed):{})};});
  const raw=elements.map(e=>e.type==='image'&&e.implementation&&!e.artisticText?{...e,type:'svg',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'}:e),validated=validateAudit(raw,slide,images,project,index,{requireSeparatedNumbers:false,artisticAssets:assets});
  auditNumberInventory({elements:validated},originalPage.auditValidation?.numberInventory||[]);
  return elements.map((e,i)=>regionScope?.lockedElements.some(n=>n.key===e.key)&&!(e.artisticText&&e.key===regionScope.artisticText?.key)?structuredClone(regionScope.lockedElements.find(n=>n.key===e.key)):targetKey&&e.key!==targetKey?structuredClone(originalPage.elements[i]):e.type==='image'&&e.implementation?{...e,...box(e)}:{...e,...validated[i]});
}
export function patchRebuiltScene(current,patch,context){
  let elements=structuredClone(current);const remove=patch.remove??[],add=patch.add??[],edits=patch.edits??[];
  if(![remove,add,edits].every(Array.isArray))throw Error('工具修改须使用数组');
  if(context.project?.rebuildPresentation?.version===1&&[...remove,...add.map(e=>e.key),...edits.map(e=>e.key)].some(key=>key?.startsWith('nf-progress-')))throw Error('页顶进度条由程序统一生成，不能单独修改或删除；请修改正文对象');
  if(context.targetKey&&(remove.some(k=>k!==context.targetKey)||add.some(e=>e.key!==context.targetKey)||edits.some(e=>e.key!==context.targetKey)||patch.order!==undefined))throw Error('单元素修改只允许操作 '+context.targetKey+'，其他元素和叠放顺序已锁定');
  if(context.regionScope){const locked=new Set(context.regionScope.lockedElements.map(e=>e.key));if(remove.some(k=>locked.has(k))||edits.some(e=>locked.has(e.key))||add.some(e=>locked.has(e.key)))throw Error('区域补拆只能新增或调整新拆出的元素，已有元素已锁定');}
  for(const key of remove){const e=elements.find(e=>e.key===key);if(!e)throw Error('对象不存在：'+key);if(e.type==='text'||(e.type==='image'&&!e.implementation))throw Error('不得删除准确文字或登记原图');elements=elements.filter(e=>e.key!==key);}
  for(const edit of edits){const e=elements.find(e=>e.key===edit.key);if(!e)throw Error('对象不存在：'+edit.key);if(!edit.properties||Object.keys(edit.properties).some(k=>!editable.has(k)))throw Error('仅可调整几何、字级与视觉样式，不能修改文案/身份');Object.assign(e,edit.properties);if(Object.hasOwn(edit.properties,'fontFace')){delete e.requestedFontFace;delete e.fontSubstitution;}}
  for(const e of add){if(!['rect','ellipse','line','shape','text'].includes(e.type))throw Error('新增复杂元素须使用create_visual_asset');elements.push(e);}
  if(patch.order!==undefined){if(!Array.isArray(patch.order)||patch.order.length!==elements.length||new Set(patch.order).size!==elements.length||patch.order.some(k=>!elements.some(e=>e.key===k)))throw Error('叠放顺序必须包含全部对象且不重复');elements=patch.order.map(k=>elements.find(e=>e.key===k));}
  if(context.targetKey){const target=elements.find(e=>e.key===context.targetKey);if(!target||elements.length!==current.length)throw Error('单元素修改必须保留目标编号，替换时使用同一key');elements=context.originalPage.elements.map(e=>e.key===context.targetKey?target:elements.find(n=>n.key===e.key));}
  return validateRebuiltScene(elements,context);
}

export async function repairRebuiltPage({p,index,review,round,env,signal,reference,rendered,background,heatmap,createAsset,renderScene,record,requestModel}){
  const config=env.credentials.get(p.id)?.text;if(!config?.key)throw Error('自动重建修正需要配置支持图片输入的主模型');
  const originalPage=structuredClone(p.reconstruction.slides[index]),draft=structuredClone(originalPage),assets=[];
  const targetKey=review.targetKey,target=targetKey?originalPage.elements.find(e=>e.key===targetKey):null;
  if(targetKey&&!target)throw Error('指定元素不存在，未修改页面');
  const context=()=>({slide:p.slides[index],project:p,index,originalPage,assets:[...p.materials,...assets],targetKey,regionScope:review.regionScope});
  const resolveFonts=async()=>{
    const editableText=draft.elements.filter(e=>e.type==='text'&&(!targetKey||e.key===targetKey)&&!review.regionScope?.lockedElements?.some(n=>n.key===e.key));
    const resolved=await prepareElementFonts(p,env,editableText,signal);
    const byKey=new Map(resolved.elements.map(e=>[e.key,e]));
    draft.elements=draft.elements.map(e=>byKey.get(e.key)||e);
    const changedKeys=new Set(editableText.map(e=>e.key));
    draft.fontSubstitutions=[...(draft.fontSubstitutions||[]).filter(e=>!changedKeys.has(e.key)),...resolved.changes];
  };
  const content=[{type:'text',text:`重建页面工具修正：第${index+1}页，第${round}轮。前三张图依次是已批准预览、实际PowerPoint渲染、固定无字背景。请直接调用工具修正本页，匹配预览的构图、留白、相对位置、色阶、层级、文本承载与视觉重心，同时解决实际可读性和语义布局问题。准确文字来自内容树，不从预览OCR改写。${rebuildReuseRule}逐处核对相同元素的出现次数与位置；只有明确多余或用户要求删除的实例才移除，不因共用素材而减量。不要用删除内容、缩到难读或叠整页截图绕过检查。规范中academic_fill要落实在新增承载区域，不能修改登记底图或原图自带底色。逐项复核字体、字号、字重、原生斜体、是否有可见文本框及承载形状；无框文字保持无框，有框的承载单独置于文字下方。对比底图与批准预览，补回底图里没有的色块、分隔与复杂视觉元素，不能一律当成底图内容跳过。${rebuildMethodRule} ${rebuildAppearanceRule} ${textSpacingRule} ${colorAdjustmentRule} ${rebuildNumberRule} 原生简单几何支持${nativeShapeKinds.join("、")}。仅当前问题：${JSON.stringify(review)}\n当前场景：${JSON.stringify(draft)}\n准确文案与层级：${JSON.stringify(canonicalTexts(p.slides[index],p,index))}\n请inspect_page后修改，render_page复看，再结束。只给操作摘要。`},...[reference,rendered,background].map(url=>({type:'image_url',image_url:{url}}))];
  content[0].text+='\n'+artisticFontRule+'\n'+deckTitleFontRule+(p.rebuildTitleFont?.fontFace?'当前全篇标题字体：'+p.rebuildTitleFont.fontFace+'。':'')+'\n'+nativeFontContext(await availableNativeFonts());
  if(heatmap){content.push({type:'image_url',image_url:{url:heatmap}});content[0].text+='\n第四张是本地SSIM/边缘差异热力图，红色仅标记差异位置，不代表审美不合格；优先查看问题元素对应局部，禁止为追逐相似度改写准确文字。';}
  if(target){content[0].text+='\n单元素修改范围：仅允许修改目标元素，其他元素、其他页面、原图身份、准确文字和背景均锁定。忽略与目标无关的全页问题。apply_page_patch只操作目标key；create_visual_asset替换目标时使用相同key，程序原位替换。原材料图片只能修改大小位置，文字只能修改样式与位置。复杂画面目标用cutout，编辑当前独立素材，不重新截取旧预览。\n目标元素：'+JSON.stringify(target)+'\n仅本元素的修改要求：'+review.userInstruction;}
  if(review.regionScope){content[0].text+='\n区域补拆范围：用户给的是大致区域，请从第一张已批准预览中识别描述的实际元素，细化真实边界和透明轮廓，排除周围背景。框选和可搜索边界仅是位置提示，不是限制；可在整页识别完整目标，精确边界与sourceBox可超出提示区域。只补拆用户描述的目标，不改、删或重排已有元素，不重复提取已有对象。简单色块与线条用原生图形，复杂几何形状/简单平面图标用SVG重绘，复杂现实风格图标/复杂画面用cutout图生图抠图，不能直接裁个矩形当成成品。先inspect_page，按描述自主选方法并精确定位；同一目标含多个独立非文字部件时分别拆解。\n大致区域与附近定位提示（不限制实际精确边界）：'+JSON.stringify({region:review.regionScope.region,searchBox:review.regionScope.searchBox})+'\n待补拆元素描述：'+review.userInstruction;}
  if(review.regionScope?.artisticText)content[0].text+='\n本次用户明确要求书法字/艺术字AI抠图，作为原生字体规则的特例：只将以下指定准确文字替换为透明图片字形，保留原笔触、内容、轮廓及细节。调用create_visual_asset，method必须cutout，key必须与指定项一致，sourceBox圈住完整字迹，不能包含其他文字或原图；其余已有对象仍锁定。'+JSON.stringify(review.regionScope.artisticText);
  if(draft.elements.some(e=>e.artisticText))content[0].text+='\n已有artisticText=true的对象是用户指定保留的透明书法字图片；保留其准确文字与笔触，不能转回原生字体。';
  if(review.regionScope?.automaticTarget)content[0].text+='\n统一框选：用户无需选择类型或文字编号。根据第一张预览和框选区域自动识别完整目标；图形沿用原生/SVG/cutout规则，书法字或艺术字需要保留笔触时走AI透明抠图，作为文字原生重建规则的特例。调用create_visual_asset时设置contentType=artistic_text、method=cutout；由你通过预览与inspect_page的artisticTextCandidates确定textKey，程序自动替换对应文字，不叠字。key可给新素材编号，程序会映射回原文字key。只替换识别到的文字，其他内容保持锁定；不得改写文字或把图表当文字抠图。不能用apply_page_patch增删文字，也不能因文案为空就结束：框选本身就是本次要求。';
  const before=digest(draft.elements);
  let session,publishedStamp=before;
  try{session=await runModelTools({config,system:env.system,content,tools:rebuildTools,signal,requestModel,onRecord:async history=>{
      await record({round,index,model:config.model,status:'in_progress',history,before:originalPage,after:draft});
      const stamp=digest(draft.elements);
      if(typeof env.save==='function'&&stamp!==publishedStamp){
        if(p.rebuildAssetPreview?.status!=='partial'||p.rebuildAssetPreview?.stamp!==visualStamp(p))p.rebuildAssetPreview={stamp:visualStamp(p),version:p.version,revision:p.rebuildAssetPreview?.revision||0,pages:structuredClone(p.reconstruction.slides),materials:p.rebuildAssetPreview?.materials||[],status:'partial'};
        publishRebuildAssets(p,env,index,draft.elements,[...p.materials,...assets].filter(m=>m.reconstructed||assets.some(a=>a.id===m.id)),{background:draft.background,status:'partial',issues:[],failedElements:[]});
        publishedStamp=stamp;
      }
    },execute:async(name,args)=>{
    if(name==='inspect_page')return {output:{...(review.regionScope?.automaticTarget?{artisticTextCandidates:review.regionScope.artisticCandidates}:{}),instanceManifest:insertedInstanceManifest(draft.elements),expectedInstanceGroups:originalPage.auditValidation?.instanceGroups||[],expectedNumbers:originalPage.auditValidation?.numberInventory||[],elements:draft.elements,background:draft.background,issues:review.issues,accurateTexts:canonicalTexts(p.slides[index],p,index),reusableAssets:[...p.materials,...assets].filter(m=>m.reconstructed&&m.kind==='image').slice(-80).map(m=>({id:m.id,name:m.name,method:m.svg?'svg':'cutout',sha256:m.sha256})),geometryCandidates:originalPage.geometry?.candidates?.slice(0,20)||review.diagnostics?.geometricCandidates||[],localDiagnostics:review.diagnostics||null}};
    if(name==='apply_page_patch'){draft.elements=patchRebuiltScene(draft.elements,args,context());return {output:{objects:draft.elements.length,changed:true}};}
    if(name==='create_visual_asset'||name==='reuse_visual_asset'){
      if(name==='create_visual_asset'&&args.method==='svg'&&args.curveArrow)args=normalizeCurvedArrow({...args,type:'svg'});
      const reuse=name==='reuse_visual_asset';
      let existingAsset;
      if(reuse){
        existingAsset=[...p.materials,...assets].find(m=>m.id===args.assetId&&m.reconstructed&&m.kind==='image');
        if(!existingAsset)throw Error('只能复用已登记的重建素材，不能替换登记原图');
        const file=env.getImage?.(p,existingAsset.id)||(env.data?path.join(env.data,p.id,'assets',existingAsset.file):null);
        if(!file||!fs.existsSync(file)||digest(fs.readFileSync(file))!==existingAsset.sha256)throw Error('复用素材文件缺失或哈希不一致');
        args={...args,method:existingAsset.svg?'svg':'cutout'};
      }
      const detected=!reuse?automaticArtisticTarget(review.regionScope,args):null;
      if(detected){
        const previous=review.regionScope.artisticText;
        if(previous&&previous.key!==detected.key&&draft.elements.some(e=>e.key===previous.key&&e.artisticText))throw Error('同一次框选只替换同一文字目标，请继续修改已识别的书法字');
        review.regionScope.artisticText=detected;args={...args,key:detected.key};
      }
      const artistic=review.regionScope?.artisticText?.key===args.key?review.regionScope.artisticText:target?.artisticText&&args.key===target.key?target:null;
      if(!artistic){args={...args};delete args.artisticText;delete args.nodeId;delete args.text;}
      if(artistic){if(reuse||args.method!=='cutout')throw Error('书法字须使用AI图生图抠图');args={...args,artisticText:true,nodeId:artistic.nodeId,text:artistic.text};}
      const replacing=!!artistic||!!targetKey&&args.key===targetKey||!!review.regionScope&&draft.elements.some(e=>e.key===args.key)&&!review.regionScope.lockedElements.some(e=>e.key===args.key);
      if(targetKey&&!replacing)throw Error('只能替换指定元素 '+targetKey);
      if(review.regionScope&&!artistic&&review.regionScope.lockedElements.some(e=>e.key===args.key))throw Error('区域补拆不能替换已有元素');
      if(target&&replacing&&(target.type==='text'||target.type==='image'&&!target.implementation))throw Error('准确文字与登记原图仅可调整样式或几何，不能重绘替换');
      if(!replacing&&draft.elements.some(e=>e.key===args.key))throw Error('新增素材key须唯一；替换时使用新key，再删除旧装饰');
      if(typeof args.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(args.key))throw Error('素材key格式无效');box(args);
      if(!['svg','cutout'].includes(args.method))throw Error('重建方法无效；'+rebuildMethodRule);
      if(!reuse&&args.method==='svg')validateRebuildMethods([{...args,type:'svg'}]);
      if(review.regionScope&&!artistic){for(const bounds of [args,...(!reuse&&args.method==='cutout'?[args.sourceBox]:[])])validateExtractionScope([...review.regionScope.lockedElements,{...box(bounds),key:args.key,type:'image',implementation:args.method}],review.regionScope);}
      if(!reuse&&args.method==='cutout'&&!(target&&replacing&&target.type==='image'&&target.implementation))safeDecorationCrop(args.sourceBox,{elements:[...(originalPage.audit||[]),...originalPage.elements,...draft.elements,...(p.visualPages[index].images||[]).map(e=>({...e,type:'image'}))]},artistic);
      let asset=existingAsset;
      if(!asset)try{asset=await createAsset(args,draft);}catch(error){if(signal?.aborted)throw error;if(assetServiceUnavailable(error))throw stopAssetTool(error,{artistic:!!artistic});throw error;}
      if(artistic)Object.assign(asset,{artisticText:true,nodeId:artistic.nodeId,text:artistic.text});
      const prior=!replacing&&draft.elements.find(e=>e.type==='image'&&e.implementation&&e.id===asset.id&&['x','y','w','h'].every(k=>e[k]===args[k]));
      if(prior)return {output:{id:asset.id,key:prior.key,method:args.method,reused:true,alreadyPresent:true}};
      const element={...(artistic?{artisticText:true,nodeId:artistic.nodeId,text:artistic.text}:{}),...(args.curveArrow?{sourceCurveArrow:args.curveArrow}:{}),key:args.key,type:'image',id:asset.id,implementation:args.method,...(asset.localCutout?{cutoutMethod:'local-reference'}:{}),...box(localCutoutPlacement(args,asset)),description:String(args.description||args.key).slice(0,700)};
      const next=validateRebuiltScene(replacing?draft.elements.map(e=>e.key===args.key?element:e):[...draft.elements,element],{...context(),assets:[...p.materials,...assets,asset]});
      if(!p.materials.some(m=>m.id===asset.id)&&!assets.some(m=>m.id===asset.id))assets.push(asset);
      draft.elements=next;return {output:{id:asset.id,key:args.key,method:args.method,sha256:asset.sha256,reused:reuse}};
    }
    if(name==='render_page'){await resolveFonts();return {output:{renderer:'local-native-scene',objects:draft.elements.length},image:await renderScene(draft,assets)};}
    throw Error('不支持的重建工具');
  }});}catch(error){
    // A later tool/model failure must not hide objects already rebuilt successfully.
    p.materials.push(...assets.filter(m=>!p.materials.some(existing=>existing.id===m.id)));
    if(typeof env.save==='function'&&(assets.length||digest(draft.elements)!==before)){
      if(p.rebuildAssetPreview?.status!=='partial')p.rebuildAssetPreview={stamp:visualStamp(p),version:p.version,revision:0,pages:structuredClone(p.reconstruction.slides),materials:[],status:'partial'};
      publishRebuildAssets(p,env,index,draft.elements,p.materials.filter(m=>m.reconstructed),{status:'partial',issues:[error.message],failedElements:[]});
      p.rebuildAssetPreview.status=signal?.aborted?'cancelled':'partial';env.save(p);
    }
    throw error;
  }
  if(signal?.aborted)throw Error('任务已取消');
  await resolveFonts();
  draft.elements=validateRebuiltScene(draft.elements,context());
  const changed=digest(draft.elements)!==before;await record({round,index,model:config.model,...session,changed,before:originalPage,after:draft});
  p.materials.push(...assets.filter(m=>!p.materials.some(existing=>existing.id===m.id)));p.reconstruction.assets=[...new Set([...p.reconstruction.assets,...draft.elements.filter(e=>e.type==='image'&&e.implementation).map(e=>e.id)])];p.reconstruction.slides[index]={...draft,toolRepair:{round,model:config.model,mode:session.mode,calls:session.calls,summary:session.summary}};
  if(typeof env.save==='function'&&p.rebuildAssetPreview?.status==='partial'){publishRebuildAssets(p,env,index,draft.elements,p.materials.filter(m=>m.reconstructed),{background:draft.background,status:'done',issues:[],failedElements:[]});if(p.rebuildAssetPreview.pages.every(page=>!page?.status||page.status==='done'))p.rebuildAssetPreview.status='done';env.save(p);}
  return {changed,session,errors:[...new Set([...(session.stopped?[session.summary]:[]),...session.history.filter(entry=>entry.status==='failed').map(entry=>entry.result.error)])]};
}
