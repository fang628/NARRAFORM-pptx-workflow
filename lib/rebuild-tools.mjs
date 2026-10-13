import {validateAudit,canonicalTexts,box,nativeSVG,digest} from './visual-model.mjs';
import {nativeShapeKinds} from './native-shapes.mjs';
import {runModelTools} from './model-tools.mjs';
import {rebuildMethodRule} from './rebuild-methods.mjs';

const tool=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const rebuildTools=[
  tool('inspect_page','读取当前页准确内容、所有独立对象、问题和固定底图。'),
  tool('apply_page_patch','修改本页对象坐标、字号size、字体fontFace、bold/italic、颜色、填充、线宽及层级。有框文字的承载单独用原生shape/rect或SVG，无框文字不新增承载；补回底图未含的色块。可新增原生图形；不能改变文字/材料身份或删除文字和原图。',{edits:{type:'array',items:{type:'object',properties:{key:{type:'string'},properties:{type:'object'}},required:['key','properties']}},add:{type:'array',items:{type:'object'}},remove:{type:'array',items:{type:'string'}},order:{type:'array',items:{type:'string'}}}),
  tool('create_visual_asset','复杂形状或图标用svg重绘；复杂画面元素用cutout附局部参考图进行图生图抠图，输出透明独立素材。简单色块与线条用apply_page_patch新增PPT原生图形。成功后自动加入本页，可删除旧装饰。',{method:{type:'string',enum:['svg','cutout']},key:{type:'string'},x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'},svg:{type:'string'},prompt:{type:'string'},sourceBox:{type:'object',properties:{x:{type:'number'},y:{type:'number'},w:{type:'number'},h:{type:'number'}},required:['x','y','w','h']},description:{type:'string'}},['method','key','x','y','w','h']),
  tool('render_page','渲染当前独立元素场景以复看布局，返回图像。最终仍必须用真实PowerPoint渲染复查。')
];
const editable=new Set(['x','y','w','h','size','fontFace','italic','bold','align','color','fill','opacity','fillOpacity','colorOpacity','strokeWidth','shape']);
const overlaps=(a,b)=>Math.min(a.x+a.w,b.x+b.w)>Math.max(a.x,b.x)&&Math.min(a.y+a.h,b.y+b.h)>Math.max(a.y,b.y);
export function safeDecorationCrop(sourceBox,page){
  const crop=box(sourceBox);if(crop.w*crop.h>1600*900*.35)throw Error('只允许抠取独立局部装饰，不允许整页或大块布局');
  if(page.elements.filter(e=>e.type==='text'||(e.type==='image'&&!e.implementation)).some(e=>overlaps(crop,e)))throw Error('抠图区域不得包含文字、图表或登记原图');
  return crop;
}
export function validateRebuiltScene(elements,{slide,project,index,originalPage,assets}){
  const protectedText=new Map(canonicalTexts(slide,project,index).map(n=>[n.nodeId,n.text])),factImages=originalPage.elements.filter(e=>e.type==='image'&&!e.implementation),knownAssets=new Set(assets.map(m=>m.id));
  for(const e of elements){
    if(e.type==='text'&&protectedText.get(e.nodeId)!==e.text)throw Error('工具不得修改准确文案或文字身份');
    if(e.type==='image'&&!e.implementation&&!factImages.some(n=>n.nodeId===e.nodeId&&n.id===e.id))throw Error('工具不得替换登记原图');
    if(e.type==='image'&&e.implementation&&!knownAssets.has(e.id))throw Error('重建素材必须通过工具登记');
    for(const k of ['fillOpacity','colorOpacity'])if(e[k]!==undefined&&(!Number.isFinite(e[k])||e[k]<0||e[k]>1))throw Error('透明度必须为0–1');
  }
  const images=factImages.map(e=>{const changed=elements.find(n=>n.type==='image'&&!n.implementation&&n.nodeId===e.nodeId);return {...e,...(changed?box(changed):{})};});
  const raw=elements.map(e=>e.type==='image'&&e.implementation?{...e,type:'svg',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>'}:e),validated=validateAudit(raw,slide,images,project,index);
  return elements.map((e,i)=>e.type==='image'&&e.implementation?{...e,...box(e)}:{...e,...validated[i]});
}
export function patchRebuiltScene(current,patch,context){
  let elements=structuredClone(current);const remove=patch.remove??[],add=patch.add??[],edits=patch.edits??[];
  if(![remove,add,edits].every(Array.isArray))throw Error('工具修改须使用数组');
  for(const key of remove){const e=elements.find(e=>e.key===key);if(!e)throw Error('对象不存在：'+key);if(e.type==='text'||(e.type==='image'&&!e.implementation))throw Error('不得删除准确文字或登记原图');elements=elements.filter(e=>e.key!==key);}
  for(const edit of edits){const e=elements.find(e=>e.key===edit.key);if(!e)throw Error('对象不存在：'+edit.key);if(!edit.properties||Object.keys(edit.properties).some(k=>!editable.has(k)))throw Error('仅可调整几何、字级与视觉样式，不能修改文案/身份');Object.assign(e,edit.properties);}
  for(const e of add){if(!['rect','ellipse','line','shape'].includes(e.type))throw Error('新增复杂元素须使用create_visual_asset，准确文字不能在此新增');elements.push(e);}
  if(patch.order!==undefined){if(!Array.isArray(patch.order)||patch.order.length!==elements.length||new Set(patch.order).size!==elements.length||patch.order.some(k=>!elements.some(e=>e.key===k)))throw Error('叠放顺序必须包含全部对象且不重复');elements=patch.order.map(k=>elements.find(e=>e.key===k));}
  return validateRebuiltScene(elements,context);
}

export async function repairRebuiltPage({p,index,review,round,env,signal,reference,rendered,background,createAsset,renderScene,record}){
  const config=env.credentials.get(p.id)?.text;if(!config?.key)throw Error('自动重建修正需要配置支持图片输入的主模型');
  const originalPage=structuredClone(p.reconstruction.slides[index]),draft=structuredClone(originalPage),assets=[];
  const context=()=>({slide:p.slides[index],project:p,index,originalPage,assets:[...p.materials,...assets]});
  const content=[{type:'text',text:`重建页面工具修正：第${index+1}页，第${round}轮。前三张图依次是已批准预览、实际PowerPoint渲染、固定无字背景。请直接调用工具修正本页，匹配预览的构图、留白、相对位置、色阶、层级、文本承载与视觉重心，同时解决实际可读性和语义布局问题。准确文字来自内容树，不从预览OCR改写。不要用删除内容、缩到难读或叠整页截图绕过检查。规范中academic_fill要落实在新增承载区域，不能修改登记底图或原图自带底色。逐项复核字体、字号、字重、是否有可见文本框及承载形状；无框文字保持无框，有框的承载单独置于文字下方。对比底图与批准预览，补回底图里没有的色块、分隔与复杂视觉元素，不能一律当成底图内容跳过。${rebuildMethodRule} 原生简单几何支持${nativeShapeKinds.join("、")}。仅当前问题：${JSON.stringify(review)}\n当前场景：${JSON.stringify(draft)}\n准确文案与层级：${JSON.stringify(canonicalTexts(p.slides[index],p,index))}\n请inspect_page后修改，render_page复看，再结束。只给操作摘要。`},...[reference,rendered,background].map(url=>({type:'image_url',image_url:{url}}))];
  const before=digest(draft.elements);
  const session=await runModelTools({config,system:env.system,content,tools:rebuildTools,signal,onRecord:history=>record({round,index,model:config.model,status:'in_progress',history,before:originalPage,after:draft}),execute:async(name,args)=>{
    if(name==='inspect_page')return {output:{elements:draft.elements,background:draft.background,issues:review.issues,accurateTexts:canonicalTexts(p.slides[index],p,index)}};
    if(name==='apply_page_patch'){draft.elements=patchRebuiltScene(draft.elements,args,context());return {output:{objects:draft.elements.length,changed:true}};}
    if(name==='create_visual_asset'){
      if(draft.elements.some(e=>e.key===args.key))throw Error('新增素材key须唯一；替换时使用新key，再删除旧装饰');
      if(typeof args.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(args.key))throw Error('素材key格式无效');box(args);
      if(!['svg','cutout'].includes(args.method))throw Error('重建方法无效；'+rebuildMethodRule);
      if(args.method==='cutout')safeDecorationCrop(args.sourceBox,{elements:[...(originalPage.audit||[]),...originalPage.elements,...draft.elements,...(p.visualPages[index].images||[]).map(e=>({...e,type:'image'}))]});
      const asset=await createAsset(args,draft);const element={key:args.key,type:'image',id:asset.id,implementation:args.method,...box(args),description:String(args.description||args.key).slice(0,700)};
      const next=validateRebuiltScene([...draft.elements,element],{...context(),assets:[...p.materials,...assets,asset]});assets.push(asset);draft.elements=next;return {output:{id:asset.id,key:args.key,method:args.method,sha256:asset.sha256}};
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
