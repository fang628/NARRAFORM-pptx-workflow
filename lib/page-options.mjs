// Missing cover preserves the behavior of projects created before this option.
export const hasTitlePage=brief=>brief.cover!==false;
export const backgroundUsesForBrief=brief=>Number(brief.pages)===1?[hasTitlePage(brief)?'hero-image':'content-background']:[...(hasTitlePage(brief)?['hero-image']:[]),...(brief.toc?['toc-image']:[]),'content-background'];
export const isTOCPage=(slide,index,brief={})=>slide?.kind==='toc'||!!brief.toc&&index===(hasTitlePage(brief)?1:0);
export const isThanksPage=slide=>slide?.kind==='thanks'||/^(?:致谢|结束致谢|感谢聆听|感谢观看|谢谢(?:大家|聆听|观看)?|thank\s*you|thanks)(?:[!！。\s]*)$/i.test(String(slide?.title||'').trim());
export const pageDisallowsImages=(slide,index,brief={})=>isTOCPage(slide,index,brief)||isThanksPage(slide);
export const specialPageVisualRule='目录页和致谢页禁止新增或插入内容图片、照片、插画及图片占位节点；仅使用文字、必要的原生几何和既定无字底图，不将缺图列为缺口。致谢页不显示进度条。';
export function assertPageImages(slide,index,brief={}){
  if(!pageDisallowsImages(slide,index,brief))return;
  const hasImage=node=>node?.type==='image'||!!node?.imageId||(node?.elements||node?.children||[]).some(hasImage);
  if(hasImage(slide))throw Error((isThanksPage(slide)?'致谢页':'目录页')+'不允许添加图片，请移除图片节点及配图');
}
export function pageStructurePrompt(brief){
  if(Number(brief.pages)===1)return `只生成 1 页独立${hasTitlePage(brief)?'封面，kind=cover':'内容页，kind=content'}，将本次要求的内容集中在这一页；不添加目录、章节页、致谢页或第二页。`;
  return `${hasTitlePage(brief)?'包含标题页（封面），第一页 kind=cover，其余页不得重复封面':'不包含标题页或封面，所有页面禁止 kind=cover，不以开场页替代封面'}；${brief.toc?'包含目录，目录位于'+(hasTitlePage(brief)?'第二页':'第一页')+'，kind=toc':'不包含目录页'}；${brief.thanks?'包含唯一结束致谢，最后一页 kind=thanks':'不包含致谢或独立结束页'}。${specialPageVisualRule}总页数包含所有已选页面，不能在目标页数之外再追加封面、目录或致谢；先分配总页数，提交前核对 slides 数量。`;
}
export function validateGeneratedTitlePage(slides,brief){
  const coverIndices=slides.flatMap((s,i)=>s.kind==='cover'?[i]:[]);
  if(hasTitlePage(brief)?coverIndices.length!==1||coverIndices[0]!==0:coverIndices.length!==0)throw Error(hasTitlePage(brief)?'模型未按要求在第一页生成唯一标题页，请重试':'已关闭标题页，但模型仍返回封面，请重试');
}
