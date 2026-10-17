import {minimumImageSize} from './image-space-budget.mjs';
export const contentImageSelectionRules='逐页主动匹配候选图片与内容：先逐组查找可用配图，再组织短文案，优先图文结合，避免整页只有长文本列表。凡能明确支持本页观点、解释步骤或展示结果的已登记图片，必须实际插入 elements 的 image 节点，不仅列在 sources、notes 或缺图说明中。有多张互补且相关的图时按主题分组插入，不因旧格式 imageId 只能存一张而漏图；同组重复图择优，必要时可跨页复用。不限制普通内容页只能一张图，可用多图比较、步骤配图或局部细节支撑对应内容；图片数量服从相关性与清晰度，不为凑数重复或硬塞。图片的 parentId 指向它解释的小标题或正文，图注从属于图片，与对应文字紧邻排布；优先原始图、文档提取图、人工裁片及已有 AI 补充图，不用新示意替代现成证据。不要只凭宽泛主题硬塞图片，不臆测未理解的画面；仅缺少合适图片时列出缺口。封面/目录沿用已确认配图设置，其默认无图例外不得扩展到普通内容页。用户明确删除或排除的图片尊重其要求。';

export function materialImageCatalog(p){
  const readings=p.analysis?.readings||[];
  return p.materials.filter(m=>m.kind==='image'&&!m.reconstructed&&m.purpose!=='reconstruction'&&m.purpose!=='workflow-background').map(m=>{
    const reading=readings.find(r=>r.id===m.id&&r.status==='read'),source=readings.find(r=>r.id===m.sourceMaterialId&&r.status==='read');
    const supplement=m.supplementImage||m.scientificFigure;
    return {materialId:m.id,name:m.name,generated:!!m.generated,extracted:!!m.extracted,
      ...(m.sourceMaterialId?{sourceMaterialId:m.sourceMaterialId,sourceMaterialName:m.sourceMaterialName,sourceLocations:m.sourceLocations}:{}),
      ...(m.width&&m.height?{width:m.width,height:m.height}:{}),
      minimumReadableSize:minimumImageSize(m,reading),
      ...(reading?{imageSummary:reading.summary,suggestedUse:reading.suggestedUse}:{}),
      ...(source?{sourceDocumentSummary:source.summary}:{}),
      ...(supplement?{description:supplement.caption||supplement.description||supplement.name,sourceMaterialIds:supplement.sourceMaterialIds}:{}),
      ...(!reading&&!supplement?{imageContentUnreviewed:true}:{})};
  });
}
