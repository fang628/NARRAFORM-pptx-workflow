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
import {rebuildMethodRule,svgReconstructionRule} from './rebuild-methods.mjs';
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
import {cornerSymmetryRule} from './corner-symmetry.mjs';
import {localComponentSnapshot} from './local-components.mjs';

const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bounds=e=>Object.fromEntries(['x','y','w','h'].map(k=>[k,e[k]]));

export function initialSVGDetailRegions(elements=[]){
  const compact=elements.filter(e=>(e.type==='svg'||e.type==='image'&&e.implementation==='svg')&&!e.managed&&!e.artisticText
    &&e.w>=12&&e.h>=12&&e.w*e.h<1600*900*.12).sort((a,b)=>a.w*a.h-b.w*b.h);
  return compact.length?compact.slice(0,3).map(e=>({key:e.key,...bounds(e)})):
    [{x:0,y:110,w:800,h:760},{x:800,y:110,w:800,h:760}];
}

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
    rebuildReferenceRule,rebuildMethodRule,svgReconstructionRule,rebuildAppearanceRule,rebuildNumbersFor(project,index),rebuildProgressAuditRule,mainTitleGradientRule,
    shapeAdjustmentRule,cornerSymmetryRule,visualTextStyleRule,visualColorRule,pageBodyFontRule,
    parameterGroupingRule,recognitionGroupRule,lightRecognitionRule,
    '坐标与线宽均为1600×900逻辑单位，1920×1080参考像素除以1.2。框与图形允许出画布，保留完整坐标与轮廓，不裁切路径或把画布边缘当成形状边。文字与承载分别登记，图片、数字、框和重复实例逐处清点。先识别对象和遮挡，不按连通色区合并对象。',
    '直线、折线和曲线统一登记一个type:line对象，linePath:{version:1,commands:[{op:M|L|Q|C,points:[[归一化x,y],...]}],segmentGroups:{"2":"斜度组ID"}}为单条开放路径。segmentGroups按L段命令序号独立关联其他图形的slant组；不共享其他线段、宽高、位置、颜色或线宽。折线保留主要转向并尽量减少线段，忽略微小抖动，同一转角附近短碎折线合成一个转角；曲线保留控制点。圆点仅在端点或真实折点，附近圆点吸附，不为圆点新增转角；中间圆点登记linePath.nodes:[{position:[归一化x,y],diameter:逻辑直径}]，端点圆实测直径登记linePath.terminals:{begin:{diameter},end:{diameter}}；箭头和端点圆登记beginArrowType/endArrowType与对应大小，随同一路径联合拟合，不另建图形或分段组合。很粗箭头、异形箭头与光条用SVG。',
    'SVG先按参考确定闭合/开放轮廓、凸凹、朝向、孔洞、嵌套环层和遮挡，再构造路径；不要用通用符号代替内部具体线条，不把多层椭圆环概括成单条弧线。同一主体的外框、内框和柔光层共享几何基准，文字和颜色独立。',
    '先辨认可见长边的方向、平行/共线/共边关系和填充终止位置，再确定对象范围和基本形状，最后判断圆角/切角。相接面板须核对底边是否共线，不能按文字区域估计图形高度。形状不确定时附 shapeCandidates:[最多3个原生形状名称]，notes说明逐边证据；弱分界区分主体阴影与独立叠框，不因暗色拖尾增加亮色块。几何、填充、描边、光效独立判断。从属于框边的高光在主体登记edgeHighlight:{edge:"top|bottom|left|right"}，由S4/S5还原，禁止另建SVG。明确同形状重复实例用recognitionGroups的parameters:["shape","corners"]登记，形状归并必须共享完整角部类型与参数；颜色组、斜度组不隐含形状组。',
    '小标题heading、副标题subtitle、表头文字不得使用字形渐变，可用color加一种强调色textColorRuns:[{color,lineSpans:[{lineIndex,startFraction,endFraction}]}]表达同一行最多两种纯色。主标题禁止描边，仅允许纯色或竖向渐变。文字与其承载图形独立判断。基础多边形和圆点按实际轮廓登记，禁止发光；自定义路径的每个顶点须对应边界，不预设单侧或双侧斜边。',
    '逐块区分小标题矮底板与正文大框，叠放仍各自登记。六边形和圆点优先原生shape/ellipse，色块及箭头禁止glow，实际阴影记shadow且与描边互斥。普通线用原生line但不得有发光/阴影；光条、光带及斜切光条使用SVG，不能用发光矩形或多条原生线替代。复杂徽标和弧形光环保留SVG或cutout层次。表格行带、表头、行列分隔线分别登记。装饰线被文字或主体打断时分别建key，不能穿过文字。单条分隔线不是新增面板依据，连续渐变不拆多框。光效不作为文本承载，面状图形无描边时strokeWidth:0。被证据否定的假框用rejectedFrames说明并删除，不删除真实承载。',
    '基础对象格式：text {key,type,nodeId,text,x,y,w,h,size,fontFace,color,bold,italic,align,charSpacing,lineSpacing,outline(仅非主标题),shadow,gradient}；formula {key,type,nodeId,latex,x,y,w,h,size,color}；rect/ellipse {key,type,x,y,w,h,fill,color,fillOpacity,colorOpacity,opacity,strokeWidth,gradient,strokeGradient,shadow}；',
    'shape {key,type:"shape",shape:"'+nativeShapeKinds.join('|')+'",x,y,w,h,fill,color,strokeWidth,gradient,strokeGradient,shadow,shapeGeometry,customGeometry,arrowDirection,arrowTail,arrowRole,frameKind,contourKind}；line {key,type,linePath:{version:1,commands:[{op:M|L|Q|C,points:[[0至1,0至1],...]}]},x,y,w,h,color,strokeWidth,beginArrowType,endArrowType,beginArrowSize,endArrowSize,gradient,strokeGradient}，ArrowSize为{width:"sm|med|lg",length:"sm|med|lg"}，line不得有glow/shadow；光条用svg；',
    'svg {key,type,x,y,w,h,svg,contourKind,description}用于按登记保留的SVG承载、粗箭头、异形箭头、光条及复杂图标，按主轮廓、孔洞、线条与效果分部件构造；cutout {key,type,x,y,w,h,sourceBox:{x,y,w,h},nonFactual:true,description}。登记原图由程序根据已批准图片计划确定性插入，模型可省略image对象；若输出image {key,type,nodeId,id,x,y,w,h}，身份和位置仍由图片计划决定，不生成替代图片或原图占位块。',
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
  return '\n本地辅助位置线索（不是对象清单，不能据此直接新增对象；structuralPanels来自可见平行长边及填充终止，结合预览核对）：'+JSON.stringify({status:report?.status,backgroundDrift:report?.diagnostics?.backgroundDrift,registration:report?.diagnostics?.registration,candidates,visibleLayers:layers,frameGroups:report?.frameEvidence?.groups?.slice(0,8),lines:report?.lines?.slice(0,24)||report?.frameEvidence?.lines?.slice(0,20),structuralPanels:report?.panels?.map(({points,boundaryKinds,confidence,evidence})=>({points,boundaryKinds,confidence,evidence}))});
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
  return {version:2,previewHash,background,layerInventory,objects,localComponents:localComponentSnapshot(elements)};
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
