import fs from 'node:fs';
import path from 'node:path';

export const agentManagedLibraryPaths=["stages/32-asset-rebuild/steps/rebuild.md", "README.md", "stages/13-design/references/style-guide.md", "stages/13-design/references/reference-categories.json", "stages/13-design/references/gen-prompt-scope.md", "stages/13-design/references/title-page.md", "stages/13-design/references/toc-page.md", "stages/13-design/references/content-page.md", "stages/13-design/references/layout-intent.md", "stages/13-design/references/layout-splits.md", "stages/13-design/references/typography-cjk.md", "shared/design-principles.md", "shared/preview-contract.md", "shared/artifact-contract.md", "shared/incremental-rework.md", "shared/content-density-and-text-color.md"];

// Only current Agent rules, style metadata and geometric examples are distributed.
// Original workflow state machines, schemas and command templates are not runtime inputs.
export function isAgentLibraryPath(file){
  return agentManagedLibraryPaths.includes(file)||[
    'stages/13-design/references/style-tokens.json',
    'stages/13-design/references/reference-index.json',
    'stages/13-design/references/reference-index.md'
  ].includes(file)||/^shared\/references\/splits\/[a-z0-9-]+\.(?:png|jpg|json)$/.test(file);
}

// Project-specific distribution policy. Never change the source skill.
export function applyLibraryPolicy(target){
  const root=path.resolve(target),reference=path.join(root,'stages/13-design/references');
  const sheets=path.resolve(reference,'reference-sheets');
  if(!sheets.startsWith(root+path.sep))throw Error('参考图目录超出规范库');
  if(fs.existsSync(sheets))fs.rmSync(sheets,{recursive:true});
  const edit=(name,change)=>{const file=path.join(reference,name);if(fs.existsSync(file))fs.writeFileSync(file,change(fs.readFileSync(file,'utf8')));};
  edit('reference-index.json',text=>{
    const index=JSON.parse(text);index.purpose='历史风格归纳的来源记录，仅保留文字元数据；参考 PPT 图片已移除';
    for(const item of index.items||[])delete item.sheet;
    return JSON.stringify(index,null,2)+'\n';
  });
  edit('reference-index.md',text=>text
    .replace(/这份索引由本地原图生成。[^\n]*/,'这份索引仅保留历史归纳的来源文字记录，参考 PPT 图片与联系表不随 Agent 分发。')
    .replace(/原件根目录：[^\n]*/,'原始参考文件不在项目规范库中；生成时仅使用文字规范与风格令牌。')
    .replace(/## 联系表[\s\S]*?(?=## 原始文件映射)/,'')
    .replace(/ \| 联系表 \|/g,' |').replace(/\|---\|---\|---\|---\|/g,'|---|---|---|')
    .replace(/ \| \[sheet-[^\n]*$/gm,' |'));
  edit('style-guide.md',text=>text
    .replace(/参考编号及原文件名见\[参考索引\]\(reference-index.md\)，缩略图见同目录 `reference-sheets\/`。/,'历史来源文字记录见[参考索引](reference-index.md)，参考 PPT 图片与联系表已从 Agent 规范库移除。')
    .replace('它们只留在参考联系表，最终新作不复制这些标识','Agent 不携带参考图片，最终新作不复制这些标识'));
  const splits=path.join(root,'shared/references/splits/index.json');
  if(fs.existsSync(splits)){
    const index=JSON.parse(fs.readFileSync(splits,'utf8'));
    index.note='本地几何示意仅作构图启发，不上传生图模型。依据真实内容关系选择粗略创意方向，适合时必须采用；不详锁逐框设计，不设特殊分块页数配额，不作为检查门槛。斜切与弧线也是正常候选。';
    fs.writeFileSync(splits,JSON.stringify(index,null,2)+'\n');
  }
}
