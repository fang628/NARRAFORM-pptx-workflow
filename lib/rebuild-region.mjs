import {artisticTextCandidates} from './artistic-text.mjs';
import {box} from './visual-model.mjs';
import {isDeepStrictEqual} from 'node:util';

export function extractionScope(raw,elements,artisticTextKey,{automaticTarget=false}={}){
  const region=box(raw);if(region.w<8||region.h<8)throw Error('请框选稍大的元素区域');
  const padX=Math.max(24,region.w*.15),padY=Math.max(24,region.h*.15),x=Math.max(0,region.x-padX),y=Math.max(0,region.y-padY);
  const target=artisticTextKey?elements.find(e=>e.key===artisticTextKey):null;
  if(artisticTextKey&&(!target||!(target.type==='text'||target.type==='image'&&target.artisticText)||target.part||!target.nodeId||target.role==='navigation'||target.nodeId.startsWith('navigation-')))throw Error('请选择本页完整的文字项，导航与拆分编号不能转为书法字图片');
  return {...(automaticTarget?{automaticTarget:true,artisticCandidates:artisticTextCandidates(elements)}:{}),...(target?{artisticText:{key:target.key,nodeId:target.nodeId,text:target.text}}:{}),region,searchBox:{x,y,w:Math.min(1600,region.x+region.w+padX)-x,h:Math.min(900,region.y+region.h+padY)-y},lockedElements:structuredClone(elements)};
}
export function validateExtractionScope(elements,scope){
  if(!scope)return;
  const locked=new Map(scope.lockedElements.map(e=>[e.key,e])),actual=elements.filter(e=>locked.has(e.key));
  const expected=scope.lockedElements.map(e=>{
    const replacement=actual.find(n=>n.key===e.key),a=scope.artisticText;
    if(a&&e.key===a.key&&replacement?.type==='image'&&replacement.artisticText===true&&replacement.implementation==='cutout'&&replacement.nodeId===a.nodeId&&replacement.text===a.text){box(replacement);return replacement;}
    return e;
  });
  if(!isDeepStrictEqual(actual,expected))throw Error('区域补拆不能修改、删除或重排已有元素');
  for(const e of elements.filter(e=>!locked.has(e.key))){
    box(e);
    if(e.type==='text'||e.type==='image'&&!e.implementation)throw Error('补拆新增文字或事实原图需先登记到内容树，不能伪造文字与图片身份');
  }
}
