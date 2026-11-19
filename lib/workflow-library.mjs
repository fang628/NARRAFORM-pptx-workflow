import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../workflow-library/',import.meta.url));
export const workflowManifest=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
export const workflowLibraryVersion=workflowManifest.version;
const cache=new Map();
export function workflowDocument(file){
  if(!workflowManifest.files.some(f=>f.file===file))throw Error('规范库文件不存在');
  if(!cache.has(file))cache.set(file,fs.readFileSync(path.join(root,file),'utf8'));
  return cache.get(file);
}
export const workflowFile=file=>workflowManifest.files.some(f=>f.file===file)?path.join(root,file):null;
const reference='stages/13-design/references/';
export const workflowStyles=JSON.parse(workflowDocument(reference+'style-tokens.json')).styles;
function section(file,title){
  const doc=workflowDocument(file),start=doc.indexOf(title);if(start<0)return '';
  const rest=doc.slice(start+title.length),end=rest.search(/\n#{1,3} /);return title+rest.slice(0,end<0?undefined:end);
}
export function workflowStyleContext({direction=null,visualTreatment,use='content-background'}={}){
  const source=direction?.presetDesign?.source;
  const role=use==='hero-image'?'cover':use==='toc-image'?'toc':'content';
  const selected=source?{palette:source.palette,typography:source.typography,decorativeShapes:source.decorativeShapes,layout:source.layout?.[role]}:
    direction?Object.fromEntries(['coreColor','styleSummary','style','typography','frames','decoration','layoutLanguage'].filter(k=>direction[k]!==undefined).map(k=>[k,direction[k]])):null;
  return '本页沿用全篇视觉方向，不重新选择预设。'+(selected?'当前方向（唯一风格依据；与旧页稿冲突时以此为准）：'+JSON.stringify(selected):'全篇方向尚未选定，仅记录适合受众的字体气质、可用配色与承载语言，后续采用所选方向。')+
    '\n当前表现类型：'+(visualTreatment||'沿用全篇')+'；共用字体、配色与框形集中写入 style，节点只写各自的承载及位置；图片中的原有颜色保留。';
}
export function workflowStyleCatalog(){
  return '风格库预设原始设计（完整采用时原样复用；仅借配色用 paletteReferenceId，不继承整套设计）：\n'+JSON.stringify(workflowStyles.map(({id,name,appliesTo,palette,decorativeShapes,typography,decorativeImages,layout})=>({id,name,appliesTo,palette,decorativeShapes,typography,decorativeImages,layout})));
}
export function workflowPageContext(p,index){
  const kind=p.slides[index]?.kind,type=kind==='cover'?'title':kind==='toc'?'toc':'content';
  const pageFile=type==='title'?'title-page.md':type==='toc'?'toc-page.md':'content-page.md';
  return `本地工作流规范库版本：${workflowLibraryVersion}；仅供当前页设计。\n`+
    (type==='content'?section(reference+pageFile,'## 内容与图片'):type==='title'?section(reference+pageFile,'## 内容与层级'):'目录仅用已确认章节原名，条目编号与承载统一，不补造章节。')+
    '\n已确认文案不再做内容阶段的字数精简；信息密集时调整分组、尺度和图文空间，不能删节点或合并多段正文。准确文字、表格与简单图形最终原生编辑。';
}
export const workflowLibrarySummary={version:workflowLibraryVersion,source:'pptx-workflow',fileCount:workflowManifest.files.length,
  styles:workflowStyles.map(s=>({id:s.id,name:s.name,appliesTo:s.appliesTo,colors:s.palette.colors.map(c=>c.hex)})),
  documents:['style-guide.md','layout-intent.md','layout-splits.md','gen-prompt-scope.md','typography-cjk.md','title-page.md','toc-page.md','content-page.md'].map(file=>({name:file,file:reference+file})),
  standards:['design-principles.md','content-density-and-text-color.md','preview-contract.md','artifact-contract.md','incremental-rework.md'].map(file=>({name:file,file:'shared/'+file}))
};
