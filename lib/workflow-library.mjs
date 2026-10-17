import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {presentationStyleScope} from './style-scope.mjs';
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
const categories=JSON.parse(workflowDocument(reference+'reference-categories.json')).categories;
function section(file,title){
  const doc=workflowDocument(file),start=doc.indexOf(title);if(start<0)return '';
  const rest=doc.slice(start+title.length),end=rest.search(/\n#{1,3} /);return title+rest.slice(0,end<0?undefined:end);
}
export function workflowStyleContext({catalogOnly=false}={}){
  const catalog='风格库预设原始设计（完整采用时原样复用；仅借配色用 paletteReferenceId，不继承整套设计）：\n'+JSON.stringify(workflowStyles.map(({id,name,appliesTo,palette,decorativeShapes,typography,decorativeImages,layout})=>({id,name,appliesTo,palette,decorativeShapes,typography,decorativeImages,layout})));
  if(catalogOnly)return catalog;
  return presentationStyleScope+'\n'+section(reference+'style-guide.md','## 风格与配色的选择')+'\n'+catalog+
    '\n'+section(reference+'gen-prompt-scope.md','## Agent 配色与风格')+
    '\n'+section('shared/design-principles.md','### 分块说明与风格要求的分工');
}
export function workflowPageContext(p,index){
  const kind=p.slides[index]?.kind,type=kind==='cover'?'title':kind==='toc'?'toc':'content';
  const pageFile=type==='title'?'title-page.md':type==='toc'?'toc-page.md':'content-page.md';
  return `本地工作流规范库版本：${workflowLibraryVersion}。规范为设计参考，当前用户指令优先；保留准确文案、材料身份与可编辑性，不额外审查材料结论严谨性。预览插回原图，可按已确认页推进，检查问题可明确接受后继续；导航位于页顶。\n`+
    workflowDocument(reference+pageFile)+
    '\n结构参考（只是样例，可创造新的内容关系版式，不必从类别中选一个；仅文字归纳，参考 PPT 图片已移除，不复制参考事实/机构/标识）：'+JSON.stringify(categories.filter(c=>c.page_type===type).map(c=>({id:c.id,layout_id:c.layout_id,layout_intent:c.layout_intent,image_slot_pattern:c.image_slot_pattern,prompt_guidance:c.prompt_guidance})))+
    '\n'+section('shared/design-principles.md','### 学术与创新创业场景的文本框处理')+
    '\n'+workflowDocument('shared/content-density-and-text-color.md')+
    '\n'+section(reference+'gen-prompt-scope.md','## Agent 七项分点结构');
}
export const workflowLibrarySummary={version:workflowLibraryVersion,source:'pptx-workflow',fileCount:workflowManifest.files.length,
  styles:workflowStyles.map(s=>({id:s.id,name:s.name,appliesTo:s.appliesTo,colors:s.palette.colors.map(c=>c.hex)})),
  documents:['style-guide.md','layout-intent.md','layout-splits.md','gen-prompt-scope.md','typography-cjk.md','title-page.md','toc-page.md','content-page.md'].map(file=>({name:file,file:reference+file})),
  standards:['design-principles.md','content-density-and-text-color.md','preview-contract.md','artifact-contract.md','incremental-rework.md'].map(file=>({name:file,file:'shared/'+file}))
};
