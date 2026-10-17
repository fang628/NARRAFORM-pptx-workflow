import {initialElements} from './elements.mjs';
import {minimumImageSize} from './image-space-budget.mjs';
export const contentImageSelectionRules='逐页主动匹配候选图片与内容：先逐组查找可用配图，再组织短文案，优先图文结合，避免整页只有长文本列表。明确支持本页观点、解释步骤或展示结果的已登记图片先按全篇择优分配；分配到本页的图片必须实际插入 elements 的 image 节点，不仅列在 sources、notes 或缺图说明中。有多张互补且相关的图时按主题分组插入，不因旧格式 imageId 只能存一张而漏图；先做全篇配图分配：同页同一图片只出现一次，内容相同但文件名或材料id不同的图片也视为重复，优先使用 duplicateOf 指向的代表素材；跨页优先使用不同且合适的图片，同一图片分配给最能说明其内容的一页，不因宽泛主题相关就反复插入。只有用户明确要求重复，或确需原图作前后对照/局部讲解时才复用；不能为去重换成不相关图片或删减正文。usedOnPages 表示当前已有使用页，整套重规划时可重新分配，不是永久禁用清单；统一主题底图不受内容配图去重限制。不限制普通内容页只能一张图，可用多图比较、步骤配图或局部细节支撑对应内容；图片数量服从相关性与清晰度，不为凑数重复或硬塞。图片的 parentId 指向它解释的小标题或正文，图片标题与图注二选一，仅保留一个直接从属于图片的text节点，与对应图片紧邻排布；图片标题role=imageTitle，不作为group小标题；优先原始图、文档提取图、人工裁片及已有 AI 补充图，不用新示意替代现成证据。不要只凭宽泛主题硬塞图片，不臆测未理解的画面；仅缺少合适图片时列出缺口。封面/目录沿用已确认配图设置，其默认无图例外不得扩展到普通内容页。用户明确删除或排除的图片尊重其要求。';

export function materialImageCatalog(p){
  const readings=p.analysis?.readings||[],representatives=new Map();
  const identity=m=>m.sha256?'sha256:'+m.sha256:m.file?'file:'+m.file:'id:'+m.id;
  const imageMaterials=p.materials.filter(m=>m.kind==='image'&&!m.reconstructed&&m.purpose!=='reconstruction'&&m.purpose!=='workflow-background');
  const used=new Map();
  for(const [index,slide] of (p.slides||[]).entries())for(const node of initialElements(slide).filter(n=>n.type==='image'&&n.materialId)){
    const material=imageMaterials.find(m=>m.id===node.materialId);if(!material)continue;
    const key=identity(material),pages=used.get(key)||new Set();pages.add(index+1);used.set(key,pages);
  }
  return imageMaterials.map(m=>{
    const key=identity(m),representative=representatives.get(key);if(!representative)representatives.set(key,m.id);
    const reading=readings.find(r=>r.id===m.id&&r.status==='read'),source=readings.find(r=>r.id===m.sourceMaterialId&&r.status==='read');
    const supplement=m.supplementImage||m.scientificFigure;
    return {materialId:m.id,name:m.name,...(representative?{duplicateOf:representative}:{}),usedOnPages:[...(used.get(key)||[])],generated:!!m.generated,extracted:!!m.extracted,
      ...(m.sourceMaterialId?{sourceMaterialId:m.sourceMaterialId,sourceMaterialName:m.sourceMaterialName,sourceLocations:m.sourceLocations}:{}),
      ...(m.width&&m.height?{width:m.width,height:m.height}:{}),
      minimumReadableSize:minimumImageSize(m,reading),
      ...(reading?{imageSummary:reading.summary,suggestedUse:reading.suggestedUse}:{}),
      ...(source?{sourceDocumentSummary:source.summary}:{}),
      ...(supplement?{description:supplement.caption||supplement.description||supplement.name,sourceMaterialIds:supplement.sourceMaterialIds}:{}),
      ...(!reading&&!supplement?{imageContentUnreviewed:true}:{})};
  });
}

// Validate AI drafts only; never remove images from the user's confirmed tree.
export function validateGeneratedImageReuse(slides,materials){
  for(const [index,slide] of slides.entries()){
    const seen=new Map();
    for(const node of initialElements(slide).filter(n=>n.type==='image'&&n.materialId)){
      const material=materials.find(m=>m.id===node.materialId),key=material?.sha256?'sha256:'+material.sha256:material?.file?'file:'+material.file:'id:'+node.materialId;
      const previous=seen.get(key);
      if(previous){const error=Error(`第 ${index+1} 页配图重复：${previous.id} 与 ${node.id} 使用同一图片`);error.repairInstruction=`本页同一图片只保留一个 image 节点；材料id不同但图片内容相同也不能重复摆放。合并重复图片的归属，图片标题或图注仍二选一，清除被删除节点的来源链接并修正其子项归属；保留其他正确文字与素材，可选择尚未使用且符合本组内容的另一张图。`;throw error;}
      seen.set(key,node);
    }
  }
}
