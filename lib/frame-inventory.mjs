export const frameInventoryRule='先清点全部新增框体，包括文字底块、圆角/切角框、箭形、六边形、斜切框与重叠框。弱分界时比较单框渐变、主体阴影和多框叠放；只有侧边错位、断边延续或独立填充边界支持另一个实体时才分别登记，不能仅凭明暗变化增加框体。同一图形的暗色投影或柔化拖尾归属主体shadow，复杂附属效果用effectOf关联；不复制主体亮色另建shape，也不将附属效果列入框体清单。各自有独立轮廓的双斜杠、嵌套面板仍分别登记，不能把重叠实体合成单框。每个框独立key和完整轮廓，文字独立。文本承载以最初登记的实现方式还原，frameInventory:[{key,kind,description}]逐处对应elements；原生对象保持原生轮廓，SVG对象保留完整SVG，不因文字归属改变实现路线。不得删除已识别的框或改成默认矩形逃避真实轮廓。只排除固定底图和程序管理的导航。';

const nativeFrames=new Set(['rect','ellipse','shape']);
const frameRole=e=>e?.role==='carrier'||e?.role==='frame'||e?.frameKind||e?.isFrame===true;
export function auditFrameInventory(raw,previous=[]){
  if(raw?.frameInventory!==undefined&&(!Array.isArray(raw.frameInventory)||raw.frameInventory.length>220))throw Error('框体清点表格式无效');
  // Explicitly rejected hypotheses can leave the inventory without permitting
  // silent deletion of a real frame. Keep a short reason for the audit record.
  const rejected=new Set((raw?.rejectedFrames||[]).filter(f=>f&&typeof f.key==='string'&&typeof f.reason==='string'&&f.reason.trim().length>=8).map(f=>f.key));
  if([...rejected].some(key=>(raw.elements||[]).some(e=>e.key===key)))throw Error('否定的框体仍在元素清单中');
  const effects=new Set((raw.elements||[]).filter(e=>e.type==='line'||e.arrowRole==='connector'||e.role==='effect'||e.effectOf||e.visualKind==='light-effect').map(e=>e.key));
  const inventory=new Map(previous.filter(f=>!rejected.has(f.key)&&!effects.has(f.key)).map(f=>[f.key,{...f}]));
  const remember=f=>{
    if(!f||typeof f.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(f.key))throw Error('框体清点表缺少有效key');
    inventory.set(f.key,{...inventory.get(f.key),key:f.key,kind:String(f.kind||inventory.get(f.key)?.kind||'frame').slice(0,50),description:String(f.description||inventory.get(f.key)?.description||'').slice(0,500)});
  };
  for(const f of raw.frameInventory||[])if(!rejected.has(f.key)&&!effects.has(f.key))remember(f);
  const elements=raw.elements||[];
  for(const e of elements)if(e&&!effects.has(e.key)&&e.managed!=='progress'&&e.managed!=='footer'&&e.role!=='navigation'&&e.role!=='background'&&!e.key?.startsWith('nf-progress-')&&!e.key?.startsWith('nf-footer-')&&e.key!=='background'&&(nativeFrames.has(e.type)||frameRole(e)))remember({key:e.key,kind:e.frameKind||e.contourKind||e.shape||e.type,description:e.description});
  const frames=[...inventory.values()];
  const missing=frames.filter(f=>!elements.some(e=>e.key===f.key&&(nativeFrames.has(e.type)||['svg','cutout'].includes(e.type)||e.type==='image'&&e.implementation)));
  if(missing.length)throw Object.assign(Error('审计遗漏已识别框体：'+missing.map(f=>f.key+'('+f.kind+')').join('、')+'；请按原轮廓补回原生预设或自定义几何，不得删除清点项'),{frameInventory:frames});
  return frames;
}
