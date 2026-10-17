import {backgroundSubjectRule,backgroundVariationRule,distinguishBackgroundVisuals} from './theme-subject-policy.mjs';
import {preserveReferencedDesign,presetPreservationRule} from './preset-design.mjs';

export const themeDirectionConsistencyRule=presetPreservationRule+'原创 A/B/C 方向的主色须分别属于明显不同的色系，不能用同色系深浅微调凑方案，并避开所选预设的主色；预设之间色系相近时保留原色，不强行改色。同方向全套底色一致；艺术主体不在三方向或各页型间强制统一。'+backgroundSubjectRule+backgroundVariationRule;
const palette=['#E6F0FA','#F4E3C3','#D3E8DF','#E5D5EB','#D5E8ED','#EBD5D1','#142B45','#49364F','#214D30','#334C43','#593D25','#5A2836','#F0D879','#D9D9D9'];
function lab(hex){
  const [r,g,b]=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v>.04045?((v+.055)/1.055)**2.4:v/12.92);
  const f=v=>v>216/24389?Math.cbrt(v):(24389/27*v+16)/116;
  const x=f((r*.4124564+g*.3575761+b*.1804375)/.95047),y=f(r*.2126729+g*.7151522+b*.072175),z=f((r*.0193339+g*.119192+b*.9503041)/1.08883);
  return [116*y-16,500*(x-y),200*(y-z)];
}
export function themeColorDistance(a,b){const x=lab(a),y=lab(b);return Math.hypot(...x.map((v,i)=>v-y[i]));}
function colorTone(hex){
  const [r,g,b]=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
  const [,a,bb]=lab(hex),s=max?delta/max:0;
  if(Math.hypot(a,bb)<6||s<.08)return {family:'neutral',hue:null};
  const hue=((max===r?(g-b)/delta:max===g?(b-r)/delta+2:(r-g)/delta+4)*60+360)%360;
  const family=hue<18||hue>=345?'red':hue<48?'orange':hue<78?'yellow':hue<165?'green':hue<200?'cyan':hue<270?'blue':hue<315?'purple':'magenta';
  return {family,hue};
}
export const themeColorFamily=hex=>colorTone(hex).family;
export function distinctThemeColorFamilies(a,b){
  const x=colorTone(a),y=colorTone(b);
  if(x.family===y.family||themeColorDistance(a,b)<16)return false;
  if(x.hue===null||y.hue===null)return true;
  const gap=Math.abs(x.hue-y.hue);return Math.min(gap,360-gap)>=55;
}
// Correct the plan before immutable style registration and prompt confirmation.
// Existing generated directions are never changed when replacing just one direction.
export function harmonizeThemeDirections(directions,p,{reservedColors=[],previousColor=null}={}){
  const normalizedDirections=directions.map(d=>preserveReferencedDesign(d,p));
  const colors=[...reservedColors,...normalizedDirections.filter(d=>d.referenceStyleId||d.paletteReferenceId).map(d=>d.coreColor)];
  return normalizedDirections.map(original=>{
    const d=structuredClone(original),old=d.coreColor.toUpperCase();
    const visiblyNew=c=>!previousColor||themeColorDistance(c,previousColor)>=16;
    if(!d.referenceStyleId&&!d.paletteReferenceId&&(colors.some(c=>!distinctThemeColorFamilies(old,c))||!visiblyNew(old))){
      const candidates=palette.filter(c=>visiblyNew(c)&&colors.every(other=>distinctThemeColorFamilies(c,other)));
      candidates.sort((a,b)=>themeColorDistance(a,old)-themeColorDistance(b,old));
      d.coreColor=candidates[0];
      if(!d.coreColor)throw Error('无法确定可区分的底图主色');
      for(const key of ['style','styleSummary','typography','frames','decoration','layoutLanguage'])if(typeof d[key]==='string')d[key]=d[key].replace(new RegExp(old,'gi'),d.coreColor).replace(/(核心底色|主背景(?:底色)?|背景主色|主底色)(\s*[:：]?\s*)#[\da-f]{6}/gi,(_all,role,space)=>role+space+d.coreColor);
      // Explicit role overrides ambiguous inherited palette prose in the registered definition.
      d.style=(d.style||'')+'；主背景底色 '+d.coreColor;
      if(d.styleSummary!==undefined)d.styleSummary=d.style;
    }
    if(!d.referenceStyleId&&!d.paletteReferenceId)colors.push(d.coreColor);
    return distinguishBackgroundVisuals(d,p.brief||{},p.visualTreatment);
  });
}
