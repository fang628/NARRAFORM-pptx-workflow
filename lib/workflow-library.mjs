import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {presentationStyleScope,presentationThemeFitPolicy} from './style-scope.mjs';
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
export function workflowStyleContext(){
  return presentationStyleScope+'\n'+presentationThemeFitPolicy+'\n先按材料主题、用途与受众评估以下六类预设风格。只有完全符合主题、用途、受众和视觉语言的预设时才必须采用，并记录 referenceStyleId 与适配理由；可在该预设内自由创造构图、层级和局部组合。当预设没有完全符合或用户明确指定其他风格时，才原创并登记。版式分类仍只是样例，不要求归入已有 layout_id。新风格必须在生图前登记名称、适用理由、配色分工、文字层级、框形、装饰语言和版式规则，并绑定后续生成记录；修改这些规则时登记新版本，保留旧记录。依据题材和受众选三种方向，用户明确配色优先。学术汇报优先克制的浅底版本，不机械复制参考中的艺术字、卡片和强光效。三个方向应有真实的构图、层级、图片策略差异，而非只换色。\n'+
    JSON.stringify(workflowStyles.map(({id,name,appliesTo,palette,decorativeShapes,typography,decorativeImages,layout})=>({id,name,appliesTo,palette,decorativeShapes,typography,decorativeImages,layout})))+
    '\n'+section(reference+'gen-prompt-scope.md','## 风格说明的具体程度')+
    '\n'+section('shared/design-principles.md','### 分块说明与风格要求的分工');
}
export function workflowPageContext(p,index){
  const kind=p.slides[index]?.kind,type=kind==='cover'?'title':kind==='toc'?'toc':'content';
  const pageFile=type==='title'?'title-page.md':type==='toc'?'toc-page.md':'content-page.md';
  return `本地工作流规范库版本：${workflowLibraryVersion}。规范为设计参考，当前用户指令优先；其中原图、事实、可编辑性和批准闸门仍须遵守。网页用户已要求预览插回原图、可按已确认页推进和页顶导航。\n`+
    workflowDocument(reference+pageFile)+
    '\n结构参考（只是样例，可创造新的内容关系版式，不必从类别中选一个；仅文字转写，不上传联系表或参考页，不复制参考事实/机构/标识）：'+JSON.stringify(categories.filter(c=>c.page_type===type).map(c=>({id:c.id,layout_id:c.layout_id,layout_intent:c.layout_intent,image_slot_pattern:c.image_slot_pattern,prompt_guidance:c.prompt_guidance})))+
    '\n'+section('shared/design-principles.md','### 学术与创新创业场景的文本框处理')+
    '\n'+workflowDocument('shared/content-density-and-text-color.md')+
    '\n'+section(reference+'gen-prompt-scope.md','## 九项分点结构');
}
export const workflowLibrarySummary={version:workflowLibraryVersion,source:'pptx-workflow',fileCount:workflowManifest.files.length,
  styles:workflowStyles.map(s=>({id:s.id,name:s.name,appliesTo:s.appliesTo,colors:s.palette.colors.map(c=>c.hex)})),
  documents:['style-guide.md','layout-intent.md','layout-splits.md','gen-prompt-scope.md','typography-cjk.md','title-page.md','toc-page.md','content-page.md'].map(file=>({name:file,file:reference+file})),
  standards:['design-principles.md','content-density-and-text-color.md','preview-contract.md','artifact-contract.md','incremental-rework.md'].map(file=>({name:file,file:'shared/'+file}))
};
