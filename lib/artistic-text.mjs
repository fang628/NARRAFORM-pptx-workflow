export function artisticCutoutPrompt(args){
  return String(args.prompt||'保留原始字迹与笔触')+'\n从随附图片中精确抠出书法字/艺术字“'+args.text+'”。保留完整文字与全部笔画、原有笔触、颜色、描边及阴影；不改字、不新增字、不重新排版，不截断飞白或笔锋。移除周围背景与无关内容，输出透明背景独立字形。字间、字内镂空与飞白空隙同样透明，保留白色笔画本身；不要白底、灰底或绘制的棋盘格。';
}
export const artisticMatteVersion=1;
export function needsArtisticChromaRetry(error,{artistic,transparent}){
  return !!artistic&&!!transparent&&/书法字浅色底/.test(error?.message||'');
}
export async function withArtisticChromaRetry({attempt,artistic,isTransparent,onRetry,signal}){
  try{return await attempt();}catch(error){
    if(signal?.aborted||!needsArtisticChromaRetry(error,{artistic,transparent:isTransparent()}))throw error;
    await onRetry();
    return attempt(); // At most one chroma retry; normal local fallback handles failure.
  }
}

export function resolveArtisticTextKey(elements,region,instruction,explicitKey){
  if(explicitKey)return explicitKey;
  if(!/(书法|艺术字|手写|毛笔|calligraph|lettering)/i.test(instruction))return undefined;
  const eligible=elements.filter(e=>e.type==='text'&&!e.part&&e.nodeId&&e.role!=='navigation'&&!e.nodeId.startsWith('navigation-'));
  const named=eligible.filter(e=>String(instruction).includes(e.text)&&e.text.length>=2);
  if(named.length===1)return named[0].key;
  const inside=eligible.filter(e=>Math.min(e.x+e.w,region.x+region.w)>Math.max(e.x,region.x)&&Math.min(e.y+e.h,region.y+region.h)>Math.max(e.y,region.y));
  if(inside.length===1)return inside[0].key;
  return undefined; // Let the visual tool identify the target when geometry is ambiguous.
}

export function artisticTextCandidates(elements){
  return elements.filter(e=>(e.type==='text'||e.type==='image'&&e.artisticText)&&!e.part&&e.nodeId&&e.role!=='navigation'&&!e.nodeId.startsWith('navigation-')).map(({key,nodeId,text,x,y,w,h})=>({key,nodeId,text,x,y,w,h}));
}
export function automaticArtisticTarget(scope,args){
  if(!scope?.automaticTarget||!(args.contentType==='artistic_text'||!args.contentType&&/(书法|艺术字|手写字|毛笔字|字形|calligraph|lettering)/i.test(args.prompt||'')))return null;
  if(args.method!=='cutout')throw Error('书法字须使用AI图生图抠图，method=cutout');
  const candidates=scope.artisticCandidates||[],named=args.textKey||args.key;
  let target=candidates.find(e=>e.key===named);
  if(args.textKey&&!target)throw Error('textKey须来自inspect_page返回的本页准确文字候选，不能新增或猜测文字身份');
  if(!target&&args.sourceBox){const b=args.sourceBox,overlapped=candidates.filter(e=>Math.min(e.x+e.w,b.x+b.w)>Math.max(e.x,b.x)&&Math.min(e.y+e.h,b.y+b.h)>Math.max(e.y,b.y));if(overlapped.length===1)target=overlapped[0];}
  if(!target)throw Error('未自动定位到唯一文字：请查看预览与inspect_page的artisticTextCandidates，给textKey填写对应key后重试，无需用户指定');
  return {key:target.key,nodeId:target.nodeId,text:target.text};
}
