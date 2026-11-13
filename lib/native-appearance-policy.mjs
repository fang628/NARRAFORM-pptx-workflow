const nativeTypes=new Set(['shape','rect','ellipse','line']);
export const nativeAppearanceRule='所有原生色块、圆形、箭头和线条禁止发光glow，不复制主体或另建SVG光晕绕过限制。色块可记录实际阴影shadow:{type:"outer",color:"HEX",opacity:0至1,blur:逻辑单位,offset:逻辑单位,angle:0至360}，有阴影时不加描边；原生line同时禁止阴影。独立光条、光带和弧形光效作为SVG保留，每条只登记一次；框边高光归属主体edgeHighlight，由S4/S5拟合原生填充和描边，不能另画SVG。普通原生填充与描边渐变按参考保留类型、方向、颜色和透明度，不限制竖向；主标题与导航各按独立政策。';

export function shadowStrokeEffects(shadow,strokeWidth=0,{line=false}={}){
  const visibleShadow=shadow&&shadow.type!=='none'&&(shadow.opacity??.3)>0&&((shadow.blur??4)>0||(shadow.offset??2)>0);
  return {shadow:line?null:shadow??null,
    strokeWidth:visibleShadow&&!line?0:strokeWidth,
    strokeConflict:!!(visibleShadow&&!line&&strokeWidth>0)};
}

export function normalizeNativeAppearance(element){
  if(!nativeTypes.has(element?.type))return element;
  const pair=element.type==='line'?{shadow:null,strokeWidth:element.strokeWidth??1}:
    shadowStrokeEffects(element.shadow,element.strokeWidth??0);
  const {glow,...rest}=element;
  const next={...rest,shadow:pair.shadow,strokeWidth:pair.strokeWidth};
  if(pair.strokeConflict){next.strokeGradient=undefined;next.colorOpacity=0;}
  return next;
}
