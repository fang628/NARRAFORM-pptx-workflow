export const frameInventoryRule='先逐处清点预览中相对登记无字底图新增的全部框类承载，再拆解文字与其他元素。包括矩形/圆角框、箭形框、六边形框、斜切/异形框、描边框、图像边框、徽章与分组承载，不能当作可选装饰省略。按实际轮廓还原，不能把箭形、斜切框或六边形默认改成圆角矩形。有光晕的框可由原生底形与独立SVG发光描边分层组成。每处单独key；边框、填充、渐变、光影和内部文字分层还原。frameInventory:[{key,kind,description}]列出每个新增框体，与elements逐一对应。已经列入清单或上一轮已识别的框不能在纠错中删除，也不能改成占位矩形或平行四边形逃避真实轮廓；原生参数不合适时改用同key的SVG重绘，复杂材质/光影才用cutout，文字仍独立。包围文字的复杂框优先SVG分层重绘，不连同文字抠取。只排除已确认属于无字底图的框和程序统一生成的页顶导航；其他正文框必须保留。';

const nativeFrames=new Set(['rect','ellipse','shape']);
const frameRole=e=>e?.role==='carrier'||e?.role==='frame'||e?.frameKind||e?.isFrame===true;
export function auditFrameInventory(raw,previous=[]){
  if(raw?.frameInventory!==undefined&&(!Array.isArray(raw.frameInventory)||raw.frameInventory.length>220))throw Error('框体清点表格式无效');
  const inventory=new Map(previous.map(f=>[f.key,{...f}]));
  const remember=f=>{
    if(!f||typeof f.key!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(f.key))throw Error('框体清点表缺少有效key');
    inventory.set(f.key,{...inventory.get(f.key),key:f.key,kind:String(f.kind||inventory.get(f.key)?.kind||'frame').slice(0,50),description:String(f.description||inventory.get(f.key)?.description||'').slice(0,500)});
  };
  for(const f of raw.frameInventory||[])remember(f);
  const elements=raw.elements||[];
  for(const e of elements)if(e&&e.managed!=='progress'&&e.managed!=='footer'&&e.role!=='navigation'&&e.role!=='background'&&!e.key?.startsWith('nf-progress-')&&!e.key?.startsWith('nf-footer-')&&e.key!=='background'&&(nativeFrames.has(e.type)||frameRole(e)))remember({key:e.key,kind:e.frameKind||e.contourKind||e.shape||e.type,description:e.description});
  const frames=[...inventory.values()];
  const missing=frames.filter(f=>!elements.some(e=>e.key===f.key&&(nativeFrames.has(e.type)||['svg','cutout'].includes(e.type)||e.type==='image'&&e.implementation)));
  if(missing.length)throw Object.assign(Error('审计遗漏已识别框体：'+missing.map(f=>f.key+'('+f.kind+')').join('、')+'；请按原轮廓补回，可改用同key的SVG，不得删除清点项'),{frameInventory:frames});
  return frames;
}
