import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {renderSVG} from './render-pool.mjs';
import {ELEMENT_CLASS_ENUM_TEXT} from './element-classes.mjs';
import {buildObjectMasks} from './object-masks.mjs';
import {analyzeVisual} from './visual-analysis.mjs';
import {canonicalTexts} from './visual-model.mjs';
import {nativeShapeKinds} from './native-shapes.mjs';
import {rebuildReferenceRule} from './rebuild-reference-policy.mjs';
import {rebuildMethodRule} from './rebuild-methods.mjs';
import {rebuildAppearanceRule,rebuildNumbersFor} from './rebuild-text-parts.mjs';
import {rebuildProgressAuditRule} from './rebuild-progress.mjs';
import {visualTextStyleRule} from './visual-text-style.mjs';
import {visualColorRule} from './visual-color.mjs';
import {shapeAdjustmentRule} from './shape-adjustments.mjs';
import {pageBodyFontRule} from './body-fonts.mjs';
import {parameterGroupingRule} from './native-parameter-groups.mjs';
import {lightRecognitionRule} from './light-effects.mjs';
import {recognitionGroupRule} from './recognition-groups.mjs';
import {formulaScriptRule,formulaScriptDiagnostics} from './formula-content.mjs';
import {mainTitleGradientRule} from './text-style-policy.mjs';

const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounds=e=>Object.fromEntries(['x','y','w','h'].map(k=>[k,e[k]]));

export async function auditDetailImages(file,regions,{signal,render=renderSVG}={}){
  const valid=regions.filter(e=>['x','y','w','h'].every(k=>Number.isFinite(e[k]))&&e.w>0&&e.h>0).slice(0,3);
  if(!valid.length)return [];
  const url='data:image/png;base64,'+fs.readFileSync(file).toString('base64'),images=[];
  for(const e of valid){
    const x=Math.max(0,e.x-20),y=Math.max(0,e.y-20),w=Math.min(1600-x,e.w+40),h=Math.min(900-y,e.h+40);
    if(w<=0||h<=0)continue;
    const width=Math.min(1000,Math.max(400,Math.round(w*2))),height=Math.max(80,Math.min(1200,Math.round(width*h/w)));
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${w} ${h}"><image href="${url}" x="0" y="0" width="1600" height="900"/></svg>`;
    try{const bytes=await render(svg,{font:{loadSystemFonts:false}},signal);images.push({type:'image_url',image_url:{url:'data:image/png;base64,'+bytes.toString('base64'),detail:'original'}});}catch(error){if(signal?.aborted)throw error;}
  }
  return images;
}

export async function measureElementQuality({env,project,index,elements,reference,rendered,background,exclude=[],signal}){
  const root=path.join(env.data,project.id,'geometry-records');
  const objectMasks=await buildObjectMasks({elements,directory:path.join(root,'object-masks'),getImage:id=>env.getImage(project,id),signal});
  const spec={operation:'elements',reference,rendered,background,elements,objectMasks,exclude};
  const fingerprint=hash([4,fs.readFileSync(path.join(env.root,'tools','element_quality.py'),'utf8'),elements,exclude,objectMasks.map(({key,hash,unavailable})=>({key,hash,unavailable})),...[reference,rendered,background].map(file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'))]);
  const directory=path.join(root,'element-quality',index+'-'+fingerprint),result=path.join(directory,'quality.json');
  if(fs.existsSync(result))try{return JSON.parse(fs.readFileSync(result,'utf8'));}catch{}
  const python=process.env.PPT_AGENT_PYTHON||path.join(env.root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const quality=await analyzeVisual(env,python,spec,directory,signal);
  if(quality.status==='available')fs.writeFileSync(result,JSON.stringify(quality));
  return quality;
}

export function rebuildAuditPrompt(project,index){
  return [
    '自由元素审计：逐对象还原第一张批准预览，第二张是程序直接使用的固定底图。只登记相对底图新增的元素；底图已有内容不重复拆解。按真实叠放顺序给出完整对象数组。',
    rebuildReferenceRule,rebuildMethodRule,rebuildAppearanceRule,rebuildNumbersFor(project,index),rebuildProgressAuditRule,mainTitleGradientRule,
    shapeAdjustmentRule,visualTextStyleRule,visualColorRule,pageBodyFontRule,
    parameterGroupingRule,recognitionGroupRule,lightRecognitionRule,
    '坐标与线宽均为1600×900逻辑单位，1920×1080参考像素除以1.2。框与图形允许出画布，保留完整坐标与轮廓，不裁切路径或把画布边缘当成形状边。文字与承载分别登记，图片、数字、框和重复实例逐处清点。先识别对象和遮挡，不按连通色区合并对象。',
    '形状不确定时附 shapeCandidates:[最多3个原生形状名称]，notes说明可见凹口、平行边或杆身证据；先判基本形状再判圆角/切角；弱分界先区分主体阴影与独立叠框，依独立轮廓登记实体，不因暗色拖尾增加亮色块；不要为了凑类型强判六边形。几何、填充、描边、光效独立判断。',
    '小标题heading、副标题subtitle、表头文字不得使用字形渐变，可用color加一种强调色textColorRuns:[{color,lineSpans:[{lineIndex,startFraction,endFraction}]}]表达同一行最多两种纯色。主标题按真实效果选用渐变。文字与其承载图形独立判断。六边形和圆点优先登记基础原生类型，简单柔光用主体glow。直角梯形面板保留单侧斜边，可用四顶点原生customGeometry，不用矩形或对称梯形代替。',
    '逐块区分小标题矮底板与正文大框，叠放仍各自登记。规则六边形、圆点、直线、斜切光条的实体优先原生shape/ellipse/line，简单柔光直接记主体glow，阴影记shadow；复杂徽标、弧形光环、多层非规则视觉保留SVG或cutout层次。表格的行带/交替行底、表头带、行分隔线、列分隔线按行列分别登记，不合并或省略。水平装饰线被文字或主体打断时，左右线段分别建key，不能画线穿过文字。单条正文分隔线不是新增面板依据；连续渐变不拆成多框。柔光不使用宽硬线模拟，复杂独立光效加role:"effect"、effectOf:所属框key，不登记为文本承载框。无描边明确strokeWidth:0。被证据否定的假框返回rejectedFrames:[{key,reason:具体视觉依据}]并删除，不删除真实承载。',
    '基础对象格式：text {key,type,nodeId,text,x,y,w,h,size,fontFace,color,bold,italic,align,charSpacing,lineSpacing,outline,shadow,gradient}；formula {key,type,nodeId,latex,x,y,w,h,size,color}；rect/ellipse {key,type,x,y,w,h,fill,color,fillOpacity,colorOpacity,opacity,strokeWidth,gradient,strokeGradient,shadow,glow}；',
    'shape {key,type:"shape",shape:"'+nativeShapeKinds.join('|')+'",x,y,w,h,fill,color,strokeWidth,gradient,strokeGradient,shadow,glow,shapeGeometry,customGeometry,arrowDirection,arrowTail,arrowRole,frameKind,contourKind}；line {key,type,start,end,x,y,w,h,color,strokeWidth,beginArrowType,endArrowType,lineEffect,gradient,shadow,glow}；',
    'svg {key,type,x,y,w,h,svg,contourKind,curveArrow,description}仅用于独立非承载平面图标，按主轮廓、孔洞、线条与效果分部件构造；cutout {key,type,x,y,w,h,sourceBox:{x,y,w,h},nonFactual:true,description}。登记原图由程序根据已批准图片计划确定性插入，模型可省略image对象；若输出image {key,type,nodeId,id,x,y,w,h}，身份和位置仍由图片计划决定，不生成替代图片或原图占位块。',
    '可选粗分类（强烈建议；缺省时程序按 type/shape/fill/strokeWidth 自行推导）：'+ELEMENT_CLASS_ENUM_TEXT,
    '只输出 {elements:[...],recognitionGroups:[{id,keys:[],parameters:[],referenceKey,evidence,confidence}],layerInventory:[{key,frontOf:[]}],frameInventory:[{key,kind,description}],numberInventory:[{key,text}],repeatedElements:[{label,count,keys:[]}],notes:"必要的不确定项"}。',
    formulaScriptRule+'对于内容树公式出现以下下划线，必须与预览核对基线位置；存在差异时明确报告内容来源与视觉的冲突，不静默删除或猜测转换：'+JSON.stringify(canonicalTexts(project.slides[index],project,index)
      .filter(node=>node.type==='formula').flatMap(node=>formulaScriptDiagnostics(node.latex).map(issue=>({nodeId:node.nodeId,...issue})))),
    '准确文字：'+JSON.stringify(canonicalTexts(project.slides[index],project,index).filter(n=>n.role!=='navigation')),
    '登记原图计划：'+JSON.stringify(project.visualPages[index].images||[]),
    '设计稿：按批准预览还原，准确内容以上述清单为准。'
  ].join('\n');
}

export function compactReferenceCandidates(report,limit=12){
  return (report?.candidates||[]).slice(0,limit).map((c,i)=>({id:c.id||'region-'+i,...bounds(c),kind:c.primitive?.kind==='unclassified'?c.kind:c.primitive?.kind||c.kind,confidence:c.primitive?.confidence||c.confidence,parameters:c.primitive?.parameters}));
}

export function referenceEvidenceContext(report){
  const candidates=compactReferenceCandidates(report);
  const layers=(report?.visibleLayers||[]).slice(0,8).map(c=>({id:c.id,...bounds(c),color:c.color,touching:c.touching}));
  return '\n本地辅助位置线索（不是对象清单，合并轮廓/背景漂移不可作形状依据；frameGroups是单框/叠框待比较假设，不能据此直接增加对象）：'+JSON.stringify({status:report?.status,backgroundDrift:report?.diagnostics?.backgroundDrift,registration:report?.diagnostics?.registration,candidates,visibleLayers:layers,frameGroups:report?.frameEvidence?.groups?.slice(0,8),lines:report?.frameEvidence?.lines?.slice(0,20)});
}

export function sceneManifest(elements,{previous,raw=[],previewHash,background,quality,layerInventory=previous?.layerInventory||[]}={}){
  const before=new Map((previous?.objects||[]).map(o=>[o.instanceId,o])),declared=new Map(raw.map(e=>[e.key,e]));
  const objects=elements.map((e,order)=>{
    const input=hash(e),prior=before.get(e.key),source=declared.get(e.key)||{};
    const measured=quality?.objects?.find(o=>o.key===e.key)||(prior?.fingerprint===input?prior?.quality:undefined);
    return {instanceId:e.key,assetId:e.type==='image'?e.id:undefined,nodeId:e.nodeId,type:e.type,implementation:e.implementation,role:e.role,carrierId:e.carrierId,nativeRequired:e.nativeRequired,carrierGroup:e.carrierGroup,
      order,fullGeometry:{...bounds(e),shape:e.shape,shapeGeometry:e.shapeGeometry,customGeometry:e.customGeometry,arrowDirection:e.arrowDirection,arrowTail:e.arrowTail},
      visibleMask:{status:measured?.status==='available'?'measured-visible-evidence':'predicted-until-measured'},effectBounds:bounds(e),frontOf:layerInventory.find(layer=>layer.key===e.key)?.frontOf||[],shapeCandidates:Array.isArray(source.shapeCandidates)?source.shapeCandidates.slice(0,3):prior?.shapeCandidates||[],
      fingerprint:input,revision:prior?.fingerprint===input?prior.revision:(prior?.revision||0)+1,
      observedEvidence:e.geometryEvidence||prior?.observedEvidence,pathModel:e.customGeometry?.commands,unresolved:e.unresolved||[],quality:measured};
  });
  return {version:2,previewHash,background,layerInventory,objects};
}

// Only objects with measured differences consume expensive fitting work.
// Missing/ambiguous evidence is reported to the model, not treated as a pass.
export function refinementTargets(report,elements,{quality}={}){
  const regions=new Map((report?.regions||[]).map(r=>[r.key,r])),result={shape:new Set(),svg:new Set(),font:new Set(),issues:[]};
  for(const e of elements){
    if(e.managed||e.role==='background')continue;
    const r=regions.get(e.key),observed=quality?.objects?.find(o=>o.key===e.key);
    if((!r||!r.samples)&&!observed?.issues?.length)continue;
    const changed=observed?.issues?.length||(Number.isFinite(r?.ssim)&&r.ssim<.97)||(Number.isFinite(r?.edgeDistance)&&r.edgeDistance>1.4);
    if(!changed)continue;
    if(['rect','ellipse','shape','line'].includes(e.type)||e.type==='image'&&e.implementation==='svg'&&e.frameKind)result.shape.add(e.key);
    if(e.type==='image'&&e.implementation==='svg')result.svg.add(e.key);
    if(e.type==='text')result.font.add(e.key);
    result.issues.push({key:e.key,kind:e.type==='text'?'typography':'geometry-or-appearance',ssim:r?.ssim,edgeDistance:r?.edgeDistance,measurements:observed});
  }
  return result;
}
