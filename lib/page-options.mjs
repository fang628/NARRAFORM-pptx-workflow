// Missing cover preserves the behavior of projects created before this option.
export const hasTitlePage=brief=>brief.cover!==false;
export const backgroundUsesForBrief=brief=>Number(brief.pages)===1?[hasTitlePage(brief)?'hero-image':'content-background']:[...(hasTitlePage(brief)?['hero-image']:[]),...(brief.toc?['toc-image']:[]),'content-background'];
export const isTOCPage=(slide,index,brief)=>slide?.kind==='toc'||!!brief.toc&&index===(hasTitlePage(brief)?1:0);
export function pageStructurePrompt(brief){
  if(Number(brief.pages)===1)return `只生成 1 页独立${hasTitlePage(brief)?'封面，kind=cover':'内容页，kind=content'}，将本次要求的内容集中在这一页；不添加目录、章节页、致谢页或第二页。`;
  return `${hasTitlePage(brief)?'包含标题页（封面），第一页 kind=cover，其余页不得重复封面':'不包含标题页或封面，所有页面禁止 kind=cover，不以开场页替代封面'}；${brief.toc?'包含目录，目录位于'+(hasTitlePage(brief)?'第二页':'第一页')+'，kind=toc':'不包含目录页'}${brief.thanks?'；包含结束致谢':''}。总页数包含所有已选页面，不能在目标页数之外再追加封面、目录或致谢；先分配总页数，提交前核对 slides 数量。`;
}
export function validateGeneratedTitlePage(slides,brief){
  const coverIndices=slides.flatMap((s,i)=>s.kind==='cover'?[i]:[]);
  if(hasTitlePage(brief)?coverIndices.length!==1||coverIndices[0]!==0:coverIndices.length!==0)throw Error(hasTitlePage(brief)?'模型未按要求在第一页生成唯一标题页，请重试':'已关闭标题页，但模型仍返回封面，请重试');
}
