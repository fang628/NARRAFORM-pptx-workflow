import {carrierSVGParts} from './native-carriers.mjs';

export const lightRecognitionRule='识别时将光晕与发光实体分开：光晕是依附主体的二维柔光区域，记role:"effect",effectKind:"halo",effectOf:主体key；不把柔光外缘、明暗脊或辉光拖尾清点成独立线条/贝塞尔曲线。只有实际可见连续细亮芯且有端点/明确走向时才记effectKind:"lit-stroke",lighting:{coreConfirmed:true,evidence:"细亮芯依据"}。不确定时保留柔光，不补画亮芯；同一主体光晕不与主体边框重复描线。';
const area=e=>Math.max(0,e.w)*Math.max(0,e.h);
const intersection=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
export function identifyLightEffects(elements){
 if(!Array.isArray(elements))return elements;
 return elements.map(e=>{
  if(e?.type!=='svg')return e;
  const description=String(e.description||'').replace(/(?:无|没有|不带|without|no)\s*(?:光晕|光影|发光|glow|halo)/gi,'');
  const named=e.role==='effect'||e.effectKind||/(?:^|[-_])(?:light|glow)(?:$|[-_])/i.test(e.key)||/(?:光晕|光带|发光轮廓|辉光|halo)/i.test(description);
  if(!named)return e;
  let parts;try{parts=carrierSVGParts(e.svg).parts;}catch{return e;}
  const outlineOnly=parts.length&&parts.every(p=>p.style.fill==='none');
  if(!outlineOnly&&!e.effectKind&&e.role!=='effect')return e;
  const core=e.lighting?.coreConfirmed===true&&typeof e.lighting.evidence==='string'&&e.lighting.evidence.length>=8;
  const kind=core&&e.effectKind==='lit-stroke'?'lit-stroke':'halo';
  const owners=elements.filter(p=>p.key!==e.key&&!p.managed&&['shape','rect','ellipse'].includes(p.type)&&p.role!=='effect'&&area(p)>2000&&intersection(e,p)/Math.max(1,Math.max(area(e),area(p)))>.65);
  const owner=owners.sort((a,b)=>intersection(e,b)/area(b)-intersection(e,a)/area(a))[0];
  const {frameKind,nativeRequired,isFrame,carrierTextIds,...rest}=e;
  let svg=e.svg;
  // An unattached diffuse halo has no centreline to reconstruct. Legacy model
  // outputs that draw it as concentric stroked curves become a soft 2-D field.
  if(kind==='halo'&&outlineOnly&&!owner&&!e.effectOf){
   const colors=[...svg.matchAll(/\bstroke\s*=\s*["'](#[\da-f]{6})["']/gi)].map(m=>m[1]);
   const color=colors[0]||'#44BBDD';
   svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${e.w}" height="${e.h}" viewBox="0 0 ${e.w} ${e.h}"><defs><radialGradient id="nf-diffuse-halo"><stop offset="0" stop-color="${color}" stop-opacity=".22"/><stop offset=".45" stop-color="${color}" stop-opacity=".12"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><ellipse cx="${e.w/2}" cy="${e.h/2}" rx="${e.w/2}" ry="${e.h/2}" fill="url(#nf-diffuse-halo)"/></svg>`;
  }
  return {...rest,svg,role:'effect',visualKind:'light-effect',effectKind:kind,...(e.effectOf||owner?{effectOf:e.effectOf||owner.key}:{}),lighting:{...e.lighting,coreConfirmed:kind==='lit-stroke',evidence:kind==='lit-stroke'?e.lighting.evidence:'识别为柔光区域，未以独立细亮芯作为线条依据'}};
 });
}
