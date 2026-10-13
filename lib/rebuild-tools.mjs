import {validateAudit,canonicalTexts,box,nativeSVG,digest} from './visual-model.mjs';
import {nativeShapeKinds} from './native-shapes.mjs';
import {runModelTools} from './model-tools.mjs';
import {rebuildMethodRule} from './rebuild-methods.mjs';
import {isDeepStrictEqual} from 'node:util';
import {validateExtractionScope} from './rebuild-region.mjs';
import {expectedRebuildText,rebuildAppearanceRule,rebuildNumberRule} from './rebuild-text-parts.mjs';

const tool=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const rebuildTools=[
  tool('inspect_page','读取当前页准确内容、所有独立对象、问题和固定底图。'),
  tool('apply_page_patch','修改本页对象坐标、字号size、字体fontFace、bold/italic、颜色、填充、线宽及层级。有框文字的承载单独用原生shape/rect或SVG，无框文字不新增承载；补回底图未含的色块。可新增原生图形；不能改变文字/材料身份或删除文字和原图。',{edits:{type:'array',items:{type:'object',properties:{key:{type:'string'},properties:{type:'object'}},required:['key','properties']}},add:{type:'array',items:{type:'object'}},remove:{type:'array',items:{type:'string'}},order:{type:'array',items:{type:'string'}}}),
  tool('create_visual_asset','复杂几何形状与简单平面图标用svg重绘；复杂现实风格图标和复杂画面元素用cutout附局部参考图进行图生图抠图，输出透明独立素材。简单色块与线条用apply_page_patch新增PPT原生图形。成功后自动加入本页，可删除旧装饰。',{method:{type:'string',enum:['svg','cutout']},key:{type:'string'},x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'},svg:{type:'string'},prompt:{type:'string'},sourceBox:{type:'object',properties:{x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'}},required:['x','y','w','h']},description:{type:'string'}},['method','key','x','y','w','h']),
  tool('render_page','渲染当前独立元素场景以复看布局，返回图像。最终仍必须用真实PowerPoint渲染复查。')
];
const editable=new Set(['x','y','w','h','size','fontFace','italic','bold','align','color','fill','opacity','fillOpacity','colorOpacity','strokeWidth','shape']);
const overlaps=(a,b)=>Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x)&&Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y);
export function assertSingleElementEdit(elements,originalPage,targetKey){
  if(!targetKey)return;
  if(!originalPage.elements.some(e=>e.key===targetKey))throw Error('指定元素不存在');
  if(elements.length!==originalPage.elements.length||elements.some((e,i)=>e.key!==originalPage.elements[i].key||e.key!==targetKey&&!isDeepStrictEqual(e,originalPage.elements[i])))throw Error('单元素修改只能修改指定元素，不能增删、重排或修改其他元素');
}
export function safeDecorationCrop(sourceBox,page){
  const crop=box(sourceBox);if(crop.w*crop.h>1600*900*.35)throw Error('只允许抠取独立局部装饰，不允许整页或大块布局');
  if(page.elements.filter(e=>e.type==='text'||(e.type==='image'&&!e.implementation)).some(e=>overlaps(crop,e)))throw Error('抠图区域不得包含文字、图表或登记原图');
  return crop;
}
export function validateRebuiltScene(elements,{slide,project,index,originalPage,assets,targetKey,regionScope}){
  assertSingleElementEdit(elements,originalPage,targetKey);
  validateExtractionScope(elements,regionScope);
  const protectedText=new Map(canonicalTexts(slide,project,index).map(n=>[n.nodeId,n.text])),factImages=originalPage.elements.filter(e=>e.type==='image'&&!e.implementation),knownAssets=new Set(assets.map(m=>m.id));
  for(const e of elements){
    if(e.type==='text'&&expectedRebuildText(e,canonicalTexts(slide,project,index),project,index,{requireSeparatedNumbers:false}).text!==e.text)throw Error('工具不得修改准确文案或文字身份');
    if(e.type==='image'&&!e.implementation&&!factImages.some(n=>n.nodeId===e.nodeId&&n.id===e.id))throw Error('工具不得替换登记原图');
    if(e.type==='image'&&e.implementation&&!knownAssets.has(e.id))throw Error('重建素材必须通过工具登记');
    for(const k of ['fillOpacity','colorOpacity'])if(e[k]!==undefined&&(!Number.isFinite(e[k])||e[k]<0||e[k]>1))throw Error('透明度必须为0–1');
  }
  const images=factImages.map(e=>{const changed=elements.find(n=>n.type==='image'&&!n.implementation&&n.nodeId===e.nodeId);return {...e,...(changed?box(changed):{})};});
  const raw=elements.map(e=>e.type==='image'&&e.implementation?{...e,type:'svg',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'}:e),validated=validateAudit(raw,slide,images,project,index,{requireSeparatedNumbers:false});
  return elements.map((e,i)=>regionScope?.lockedElements.some(n=>n.key===e.key)?structuredClone(regionScope.lockedElements.find(n=>n.key===e.key)):targetKey&&e.key!==targetKey?structuredClone(originalPage.elements[i]):e.type==='image'&&e.implementation?{...e,...box(e)}:{...e,...validated[i]});
}
export function patchRebuiltScene(current,patch,context){
  let elements=structuredClone(current);const remove=patch.remove??[],add=patch.add??[],edits=patch.edits??[];
  if(![remove,add,edits].every(Array.isArray))throw Error('工具修改须使用数组');
  if(context.targetKey&&(remove.some(k=>k!==context.targetKey)||add.some(e=>e.key!==context.targetKey)||edits.some(e=>e.key!==context.targetKey)||patch.order!==undefined))throw Error('单元素修改只允许操作 '+context.targetKey+'，其他元素和叠放顺序已锁定');
  if(context.regionScope){const locked=new Set(context.regionScope.lockedElements.map(e=>e.key));if(remove.some(k=>locked.has(k))||edits.some(e=>locked.has(e.key))||add.some(e=>locked.has(e.key)))throw Error('区域补拆只能新增或调整新拆出的元素，已有元素已锁定');}
  for(const key of remove){const e=elements.find(e=>e.key===key);if(!e)throw Error('对象不存在：'+key);if(e.type==='text'||(e.type==='image'&&!e.implementation))throw Error('不得删除准确文字或登记原图');elements=elements.filter(e=>e.key!==key);}
  for(const edit of edits){const e=elements.find(e=>e.key===edit.key);if(!e)throw Error('对象不存在：'+edit.key);if(!edit.properties||Object.keys(edit.properties).some(k=>!editable.has(k)))throw Error('仅可调整几何、字级与视觉样式，不能修改文案/身份');Object.assign(e,edit.properties);}
  for(const e of add){if(!['rect','ellipse','line','shape'].includes(e.type))throw Error('新增复杂元素须使用create_visual_asset，准确文字不能在此新增');elements.push(e);}
  if(patch.order!==undefined){if(!Array.isArray(patch.order)||patch.order.length!==elements.length||new Set(patch.order).size!==elements.length||patch.order.some(k=>!elements.some(e=>e.key===k)))throw Error('叠放顺序必须包含全部对象且不重复');elements=patch.order.map(k=>elements.find(e=>e.key===k));}
  if(context.targetKey){const target=elements.find(e=>e.key===context.targetKey);if(!target||elements.length!==current.length)throw Error('单元素修改必须保留目标编号，替换时使用同一key');elements=context.originalPage.elements.map(e=>e.key===context.targetKey?target:elements.find(n=>n.key===e.key));}
  return validateRebuiltScene(elements,context);
}

export async function repairRebuiltPage({p,index,review,round,env,signal,reference,rendered,background,createAsset,renderScene,record,requestModel}){
  const config=env.credentials.get(p.id)?.text;if(!config?.key)throw Error('自动重建修正需要配置支持图片输入的主模型');
  const originalPage=structuredClone(p.reconstruction.slides[index]),draft=structuredClone(originalPage),assets=[];
  const targetKey=review.targetKey,target=targetKey?originalPage.elements.find(e=>e.key===targetKey):null;
  if(targetKey&&!target)throw Error('指定元素不存在，未修改页面');
  const context=()=>({slide:p.slides[index],project:p,index,originalPage,assets:[...p.materials,...assets],targetKey,regionScope:review.regionScope});
  const content=[{type:'text',text:`重建页面工具修正：第${index+1}页，第${round}轮。前三张图依次是已批准预览、实际PowerPoint渲染、固定无字背景。请直接调用工具修正本页，匹配预览的构图、留白、相对位置、色阶、层级、文本承载与视觉重心，同时解决实际可读性和语义布局问题。准确文字来自内容树，不从预览OCR改写。不要用删除内容、缩到难读或叠整页截图绕过检查。规范中academic_fill要落实在新增承载区域，不能修改登记底图或原图自带底色。逐项复核字体、字号、字重、是否有可见文本框及承载形状；无框文字保持无框，有框的承载单独置于文字下方。对比底图与批准预览，补回底图里没有的色块、分隔与复杂视觉元素，不能一律当成底图内容跳过。${rebuildMethodRule} ${rebuildAppearanceRule} ${rebuildNumberRule} 原生简单几何支持${nativeShapeKinds.join("、")}。仅当前问题：${JSON.stringify(review)}\n当前场景：${JSON.stringify(draft)}\n准确文案与层级：${JSON.stringify(canonicalTexts(p.slides[index],p,index))}\n请inspect_page后修改，render_page复看，再结束。只给操作摘要。`},...[reference,rendered,background].map(url=>({type:'image_url',image_url:{url}}))];
  if(target){content[0].text+='\n单元素修改范围：仅允许修改目标元素，其他元素、其他页面、原图身份、准确文字和背景均锁定。忽略与目标无关的全页问题。apply_page_patch只操作目标key；create_visual_asset替换目标时使用相同key，程序原位替换。原材料图片只能修改大小位置，文字只能修改样式与位置。复杂画面目标用cutout，编辑当前独立素材，不重新截取旧预览。\n目标元素：'+JSON.stringify(target)+'\n仅本元素的修改要求：'+review.userInstruction;}
  if(review.regionScope){content[0].text+='\n区域补拆范围：用户给的是大致区域，请从第一张已批准预览中识别描述的实际元素，细化真实边界和透明轮廓，排除周围背景。框选和可搜索边界仅是位置提示，不是限制；可在整页识别完整目标，精确边界与sourceBox可超出提示区域。只补拆用户描述的目标，不改、删或重排已有元素，不重复提取已有对象。简单色块与线条用原生图形，复杂几何形状/简单平面图标用SVG重绘，复杂现实风格图标/复杂画面用cutout图生图抠图，不能直接裁个矩形当成成品。先inspect_page，按描述自主选方法并精确定位；同一目标含多个独立非文字部件时分别拆解。\n大致区域与附近定位提示（不限制实际精确边界）：'+JSON.stringify({region:review.regionScope.region,searchBox:review.regionScope.searchBox})+'\n待补拆元素描述：'+review.userInstruction;}
  const before=digest(draft.elements);
  const session=await runModelTools({config,system:env.system,content,tools:rebuildTools,signal,requestModel,onRecord:history=>record({round,index,model:config.model,status:'in_progress',history,before:originalPage,after:draft}),execute:async(name,args)=>{
    if(name==='inspect_page')return {output:{elements:draft.elements,background:draft.background,issues:review.issues,accurateTexts:canonicalTexts(p.slides[index],p,index)}};
    if(name==='apply_page_patch'){draft.elements=patchRebuiltScene(draft.elements,args,context());return {output:{objects:draft.elements.length,changed:true}};}
    if(name==='create_visual_asset'){
      const replacing=!!targetKey&&args.key===targetKey||!!review.regionScope&&draft.elements.some(e=>e.key===args.key)&&!review.regionScope.lockedElements.some(e=>e.key===args.key);
      if(targetKey&&!replacing)throw Error('只能替换指定元素 '+targetKey);
      if(review.regionScope&&review.regionScope.lockedElements.some(e=>e.key===args.key))throw Error('区域补拆不能替换已有元素');
      if(target&&replacing&&(target.type==='text'||target.type==='image'&&!target.implementation))throw Error('准确文字与登记原图仅可调整样式或几何，不能重绘替换');
      if(!replacing&&draft.elements.some(e=>e.key===args.key))throw Error('新增素材key须唯一；替换时使用新key，再删除旧装饰');
      if(typeof args.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(args.key))throw Error('素材key格式无效');box(args);
      if(!['svg','cutout'].includes(args.method))throw Error('重建方法无效；'+rebuildMethodRule);
      if(review.regionScope){for(const bounds of [args,...(args.method==='cutout'?[args.sourceBox]:[])])validateExtractionScope([...review.regionScope.lockedElements,{...box(bounds),key:args.key,type:'image',implementation:args.method}],review.regionScope);}
      if(args.method==='cutout'&&!(target&&replacing&&target.type==='image'&&target.implementation))safeDecorationCrop(args.sourceBox,{elements:[...(originalPage.audit||[]),...originalPage.elements,...draft.elements,...(p.visualPages[index].images||[]).map(e=>({...e,type:'image'}))]});
      const asset=await createAsset(args,draft);const element={key:args.key,type:'image',id:asset.id,implementation:args.method,...box(args),description:String(args.description||args.key).slice(0,700)};
      const next=validateRebuiltScene(replacing?draft.elements.map(e=>e.key===args.key?element:e):[...draft.elements,element],{...context(),assets:[...p.materials,...assets,asset]});assets.push(asset);draft.elements=next;return {output:{id:asset.id,key:args.key,method:args.method,sha256:asset.sha256}};
    }
    if(name==='render_page')return {output:{renderer:'local-native-scene',objects:draft.elements.length},image:await renderScene(draft,assets)};
    throw Error('不支持的重建工具');
  }});
  if(signal?.aborted)throw Error('任务已取消');
  draft.elements=validateRebuiltScene(draft.elements,context());
  const changed=digest(draft.elements)!==before;await record({round,index,model:config.model,...session,changed,before:originalPage,after:draft});
  p.materials.push(...assets);p.reconstruction.assets.push(...assets.map(m=>m.id));p.reconstruction.slides[index]={...draft,toolRepair:{round,model:config.model,mode:session.mode,calls:session.calls,summary:session.summary}};
  return {changed,session};
}
