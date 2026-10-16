import {backgroundUsesForBrief} from './page-options.mjs';
import {nonConcreteSubject,deckWideSubjectSource} from './theme-subject-policy.mjs';

export const themeDirectionConsistencyRule='A/B/C 三个方向的主色 coreColor 必须分别属于明显不同的色系，不能用同色系的深浅、明暗、冷暖微调凑三个方案，也不能都用近似白灰；蓝与邻近青蓝视为近似色系，黑白灰最多占一个方向。同一方向内封面、目录和内容背景沿用该方向主色。三个方向以及启用的各用途共用同一个代表全篇主线、贯穿全篇的材料核心主体对象，不选仅在某段、小节或局部案例出现的对象及其 subjectSources 来源，不用不同对象制造风格差异；只改变构图、视角、风格和陪衬，内容背景用同主体的低对比简化轮廓。';
const fields={'hero-image':'heroSubject','toc-image':'tocSubject','content-background':'contentSubject'};
const positions={'heroSubject':'置于封面预留视觉区','tocSubject':'置于目录预留视觉区','contentSubject':'边角低对比简化轮廓'};
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
const normalized=v=>String(v||'').replace(/[\s，,、；;：:（）()\-]/g,'').toLowerCase();
export function themeSharedSubject(directions,p,{requireDeckScope=false}={}){
  const enabled=backgroundUsesForBrief(p.brief||{}).map(use=>fields[use]);
  const concreteRequired=enabled.some(field=>field!=='contentSubject');
  for(const d of directions)for(const field of enabled){
    const source=d.subjectSources?.[field],element=source?.element||d[field];
    if(concreteRequired&&(requireDeckScope||source?.scope!==undefined)&&!deckWideSubjectSource(source))continue;
    if(element&&!/^(不使用|不适用|无|none)$/i.test(element.trim())&&(!concreteRequired||!nonConcreteSubject(element)))return {element:element.trim(),...(source?{source:structuredClone(source)}:{})};
  }
  return null;
}

// Correct the plan before immutable style registration and prompt confirmation.
// Existing generated directions are never changed when replacing just one direction.
export function harmonizeThemeDirections(directions,p,{reservedColors=[],previousColor=null,subject=themeSharedSubject(directions,p)}={}){
  const colors=[...reservedColors],enabled=backgroundUsesForBrief(p.brief||{}).map(use=>fields[use]);
  return directions.map(original=>{
    const d=structuredClone(original),old=d.coreColor.toUpperCase();
    const visiblyNew=c=>!previousColor||themeColorDistance(c,previousColor)>=16;
    if(colors.some(c=>!distinctThemeColorFamilies(old,c))||!visiblyNew(old)){
      const candidates=palette.filter(c=>visiblyNew(c)&&colors.every(other=>distinctThemeColorFamilies(c,other)));
      candidates.sort((a,b)=>themeColorDistance(a,old)-themeColorDistance(b,old));
      d.coreColor=candidates[0];
      if(!d.coreColor)throw Error('无法确定可区分的底图主色');
      for(const key of ['style','styleSummary','typography','frames','decoration','layoutLanguage'])if(typeof d[key]==='string')d[key]=d[key].replace(new RegExp(old,'gi'),d.coreColor).replace(/(核心底色|主背景(?:底色)?|背景主色|主底色)(\s*[:：]?\s*)#[\da-f]{6}/gi,(_all,role,space)=>role+space+d.coreColor);
      // Explicit role overrides ambiguous inherited palette prose in the registered definition.
      d.style=(d.style||'')+'；主背景底色 '+d.coreColor;
      if(d.styleSummary!==undefined)d.styleSummary=d.style;
    }
    colors.push(d.coreColor);
    if(subject)for(const field of enabled){
      if(!normalized(d[field]).includes(normalized(subject.element)))d[field]=subject.element+'，'+positions[field];
      if(subject.source){d.subjectSources||={};d.subjectSources[field]=structuredClone(subject.source);}
    }
    return d;
  });
}
