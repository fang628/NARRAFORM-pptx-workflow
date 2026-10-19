import {workflowStyles,workflowLibraryVersion} from './workflow-library.mjs';

export const presetPreservationRule='选用风格库预设时，原有配色、渐变、字体、字效、框形、装饰语言及页型版式规则保持不变，不重新设计或简化成另一套风格；只替换为当前材料的文案、图片与主题主体，按内容数量排布。三方向色系差异通过选型保证，不能给预设本身改色；其他方向避开已占用色系，适配预设或配色不足时采用另行登记的原创配色，不重复同一底色。用户要求全套底色一致：同一方向的封面、目录和内容页统一使用该方向核心底色，不采用原预设中的按页型换底色；其余设计保持原样。';
export const presetPaletteRule='简约平面底图先单独评估预设配色与主题、用途、受众的适配性，即使整套预设的字体、装饰或写实表现不适合，也可优先复用其配色。仅借用配色时填写 paletteReferenceId=A-F、referenceStyleId=null；复用原预设底色与全部配色，不继承其渐变、字体、字效、框形、装饰图片和版式，平面设计另外登记。没有适合且色系未被其他方向占用的预设配色时才自定配色，不因配色好看而采用不合主题的方案。完整采用预设仍用 referenceStyleId，按原规则保持整套设计。';
export function selectedPaletteId(d,p={}){
  if(d.paletteReferenceId)return d.paletteReferenceId;
  return p.visualTreatment==='flat'&&!d.referenceStyleId?d.styleSelection?.matchingPaletteIds?.[0]||null:null;
}
function paletteDesign(d,p){
  const id=selectedPaletteId(d,p);if(!id)return {...d};
  const source=workflowStyles.find(s=>s.id===id&&!s.deletedAt);
  if(!source)throw Error('预设配色编号不存在');
  const palette={colors:structuredClone(source.palette.colors)};
  const style=JSON.stringify(palette);
  return {...d,presetDesign:null,paletteReferenceId:id,paletteSource:{id,libraryVersion:workflowLibraryVersion,palette},coreColor:palette.colors[0].hex,style,...(d.styleSummary!==undefined?{styleSummary:style}:{})};
}
const stringify=v=>JSON.stringify(v);
export function referencedDesign(p,referenceStyleId,{allowDeleted=false}={}){
  const preset=workflowStyles.find(s=>s.id===referenceStyleId&&!s.deletedAt);
  if(preset){
    const source=structuredClone(preset),palette=source.palette,shapes=source.decorativeShapes;
    return {definition:{name:source.name,description:source.appliesTo,style:stringify(palette),coreColor:palette.colors[0].hex,
      typography:stringify(source.typography),frames:stringify({forms:shapes.forms.filter(s=>/卡片|标签|胶囊|矩形|框/.test(s)),colors:shapes.colors}),
      decoration:stringify({shapes,images:{treatment:source.decorativeImages.treatment,notes:source.decorativeImages.notes}}),layoutLanguage:stringify(source.layout)},
      presetDesign:{id:source.id,libraryVersion:workflowLibraryVersion,source}};
  }
  const record=p.styleRegistry?.find(r=>r.id===referenceStyleId&&(allowDeleted||!r.deletedAt));
  if(record){const {referenceStyleId:ignored,...definition}=record.definition;return {definition:structuredClone(definition),...(record.presetDesign?{presetDesign:structuredClone(record.presetDesign)}:{}),...(record.paletteSource?{paletteSource:structuredClone(record.paletteSource)}:{})};}
  return null;
}
export function preserveReferencedDesign(direction,p={},options={}){
  const reference=referencedDesign(p,direction.referenceStyleId,options);
  if(!reference)return paletteDesign(direction,p);
  const base={...direction};if(reference.presetDesign){delete base.paletteReferenceId;delete base.paletteSource;}
  return {...base,...reference.definition,presetDesign:reference.presetDesign||null,referenceStyleId:direction.referenceStyleId,
    ...(reference.paletteSource?{paletteSource:reference.paletteSource}:{}),...(direction.styleSummary!==undefined?{styleSummary:reference.definition.style}:{})};
}
export const presetPageRole=use=>use==='hero-image'?'cover':use==='toc-image'?'toc':'content';
export function presetPageColor(d,use){
  return d.coreColor;
}
export function presetLayout(d,use){
  const layout=d.presetDesign?.source.layout[presetPageRole(use)]||'';
  return layout.replace(/(?:深靛蓝|靛蓝|深色|宣纸米色|白|深褐)底|宣纸米色满版/g,'统一底色').replace(/（如[^）]*）/g,'');
}
export function presetNavigation(d){return d.presetDesign?.source.layout.content.match(/顶部([^+；;]+)/)?.[1].trim()||'页签导航';}
function pagePart(value,use){
  const text=String(value||''),role=presetPageRole(use),labels='(?:封面(?:页)?|目录(?:页)?|内页|内容页)',markers=[...text.matchAll(new RegExp(labels+'(?:[／/与和、]'+labels+')*','g'))];
  if(!markers.length)return text;
  const match=role==='cover'?/封面/:role==='toc'?/目录/:/内页|内容页/;
  return markers.flatMap((m,i)=>match.test(m[0])?[text.slice(m.index+m[0].length,markers[i+1]?.index??text.length).replace(/^[为：:\s]+|[；;、，,\s]+$/g,'')]:[]).join('；');
}
export function presetBackgroundStyle(d,use='content-background'){
  const source=d.presetDesign?.source;if(!source)return '';
  const gradient=source.palette.gradient;
  const kind=pagePart(gradient?.kind,use).replace(/(?:深靛蓝|靛蓝|深色|宣纸米色|白|深褐)底/g,'统一底色'),strength=pagePart(gradient?.strength,use);
  return [gradient?.present?kind:'原预设纯色底',strength?'渐变强度'+strength:null,source.decorativeImages.treatment].filter(Boolean).join('；');
}
