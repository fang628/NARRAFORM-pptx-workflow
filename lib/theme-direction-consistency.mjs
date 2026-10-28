import {backgroundSubjectRule,backgroundVariationRule,distinguishBackgroundVisuals} from './theme-subject-policy.mjs';
import {preserveReferencedDesign,presetPreservationRule} from './preset-design.mjs';

export const themeDirectionConsistencyRule=presetPreservationRule+'A/B/C 方向的核心底色必须属于明显不同的色系，不能用同色系深浅微调凑方案。包括完整预设与仅借配色，均需在选型时避开其他方向已经占用的色系；预设本身不改色，可选适配且不同色系的其他预设或配色，不足时其他方向采用独立原创配色并登记，不重复借用同一预设颜色。以上色系区分用于自动选型；用户手动指定参考时优先原样采用该风格，撞色只提示，不改色、不另换风格或登记为原创，也不要求与旧方向换色。同方向全套底色一致；艺术主体不在三方向或各页型间强制统一。'+backgroundSubjectRule+backgroundVariationRule;
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
export function harmonizeThemeDirections(directions,p,{reservedColors=[],previousColor=null,lockedDirectionIds=[]}={}){
  const normalizedDirections=directions.map(d=>preserveReferencedDesign(d,p));
  const colors=[...reservedColors],result=new Array(directions.length);
  const locked=d=>!!d.referenceStyleId&&lockedDirectionIds.includes(d.id);
  // Reserve complete presets first, then palette-only choices; custom colors yield to both.
  const rank=d=>locked(d)?-1:d.referenceStyleId?0:d.paletteReferenceId?1:2;
  const order=normalizedDirections.map((_,i)=>i).sort((a,b)=>rank(normalizedDirections[a])-rank(normalizedDirections[b])||a-b);
  for(const index of order){
    let d=structuredClone(normalizedDirections[index]);
    // A user's explicit selection wins over automatic diversification and novelty.
    // Report collisions without changing either the selected design or other directions.
    if(locked(d)){
      const conflictingColors=colors.filter(other=>!distinctThemeColorFamilies(d.coreColor,other));
      d.colorSelection={mode:'explicit-reference',referenceStyleId:d.referenceStyleId,conflictingColors,
        reason:conflictingColors.length?'所选风格与其他方向色系接近，已保留所选原设计与底色；可自行更换其他方向':'按指定风格原样复用设计与底色'};
      colors.push(d.coreColor);result[index]=distinguishBackgroundVisuals(d,p.brief||{},p.visualTreatment);
      continue;
    }
    const visiblyNew=c=>!previousColor||themeColorDistance(c,previousColor)>=16;
    const usable=c=>visiblyNew(c)&&colors.every(other=>distinctThemeColorFamilies(c,other));
    if(!usable(d.coreColor)&&(d.referenceStyleId||d.paletteReferenceId)){
      const full=!!d.referenceStyleId,source=d.referenceStyleId||d.paletteReferenceId;
      const alternatives=full?d.styleSelection?.matchingPresetIds||[]:d.styleSelection?.matchingPaletteIds||[];
      let alternative;
      for(const id of alternatives){
        if(id===source)continue;
        const candidate=preserveReferencedDesign({...d,referenceStyleId:full?id:null,paletteReferenceId:full?null:id},p);
        if(usable(candidate.coreColor)){alternative=candidate;break;}
      }
      if(alternative)d=alternative;
      else{
        // A different color is a new registered design, never a recolored preset claim.
        d.referenceStyleId=null;delete d.paletteReferenceId;delete d.paletteSource;delete d.presetDesign;delete d.styleRegistrationId;
        d.styleSelection={...d.styleSelection,matchingPaletteIds:[]};
        d.colorSelection={mode:'original-distinct-background',previousReference:source,reason:'适配预设或配色的色系已被其他方向占用，保留已采用的预设原设计，本方向改用独立原创配色'};
      }
    }
    const old=d.coreColor.toUpperCase();
    if(!usable(old)){
      const candidates=palette.filter(usable);
      candidates.sort((a,b)=>themeColorDistance(a,old)-themeColorDistance(b,old));
      d.coreColor=candidates[0];
      if(!d.coreColor)throw Error('无法确定可区分的底图主色');
      for(const key of ['style','styleSummary','typography','frames','decoration','layoutLanguage'])if(typeof d[key]==='string')d[key]=d[key].replace(new RegExp(old,'gi'),d.coreColor).replace(/(核心底色|主背景(?:底色)?|背景主色|主底色)(\s*[:：]?\s*)#[\da-f]{6}/gi,(_all,role,space)=>role+space+d.coreColor);
      d.style=(d.style||'')+'；主背景底色 '+d.coreColor;
      if(d.styleSummary!==undefined)d.styleSummary=d.style;
    }
    colors.push(d.coreColor);result[index]=distinguishBackgroundVisuals(d,p.brief||{},p.visualTreatment);
  }
  return result;
}
