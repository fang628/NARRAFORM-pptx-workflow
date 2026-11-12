const nativeTypes=new Set(['shape','rect','ellipse','line']);
export const nativeAppearanceRule='原生shape/rect/ellipse/line的效果在主体上记录一次：glow:{color:"HEX",opacity:0至1,radius:逻辑单位}表示边缘外侧柔光，shadow:{type:"outer",color:"HEX",opacity:0至1,blur:逻辑单位,offset:逻辑单位,angle:0至360}表示偏移阴影；没有效果明确null，遮挡无法判断时省略并记录证据。发光与描边独立，可单独存在或组合，不能由其中一项推断另一项。阴影与发光、实体描边互斥，有阴影的色块strokeWidth:0；line的strokeWidth表示线条主体，不能删掉主体。所有原生图形填充与描边渐变仅允许linear、angle:90的竖向渐变，禁止横向、斜向、径向渐变。简单主体柔光不另建SVG光晕或复制主体，复杂多层非规则光效才独立重建。';

export function exclusiveNativeEffects(glow,shadow,strokeWidth=0,{line=false}={}){
  const visibleGlow=glow&&(glow.opacity??.3)>0&&(glow.radius??4)>0;
  const visibleShadow=shadow&&shadow.type!=='none'&&(shadow.opacity??.3)>0&&((shadow.blur??4)>0||(shadow.offset??2)>0);
  return {glow:shadow&&!visibleGlow?null:glow??null,shadow:visibleGlow?null:shadow??null,
    strokeWidth:visibleShadow&&!visibleGlow&&!line?0:strokeWidth,
    conflict:!!(visibleGlow&&visibleShadow),strokeConflict:!!(visibleShadow&&!visibleGlow&&!line&&strokeWidth>0)};
}

export function normalizeNativeAppearance(element){
  if(!nativeTypes.has(element?.type))return element;
  const pair=exclusiveNativeEffects(element.glow,element.shadow,element.strokeWidth??0,{line:element.type==='line'});
  const next={...element,glow:pair.glow,shadow:pair.shadow,strokeWidth:pair.strokeWidth};
  for(const key of ['gradient','strokeGradient'])if(element[key]){
    const {center,...gradient}=element[key];next[key]={...gradient,type:'linear',angle:90};
  }
  if(pair.strokeConflict){next.strokeGradient=undefined;next.colorOpacity=0;}
  return next;
}
