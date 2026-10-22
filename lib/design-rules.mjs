import {deckTitleFontRule} from './title-fonts.mjs';
import {navigationTexts,progressPlanningRule} from './progress-navigation.mjs';
export {navigationTexts};
import {contentNodeMeaningRule} from './elements.mjs';
import {imageSpacePlanningRule} from './image-space-budget.mjs';
import {imageCaptionRule} from './image-caption-rules.mjs';
import {lightweightReviewRule,advisoryDesignChecks} from './lightweight-review.mjs';
import {isTOCPage} from './page-options.mjs';
// Web adaptation of pptx-workflow/shared/design-principles.md and density rules.
// Keep review heuristics separate from factual and structural acceptance gates.
import {themeAssetsReady,themeAssetsCurrent} from './theme-assets.mjs';
import {presentationStyleScope} from './style-scope.mjs';
import {placeholderAspectRewriteRule} from './image-placeholder-rules.mjs';
import {originalImagePlacementRule} from './image-placement-policy.mjs';
import {specialLayoutDesignGuidance,visualConnectionDesignRule,textBoxContrastRule,textContrastRule} from './layout-guidance.mjs';
import {materialFidelityPolicy} from './content-policy.mjs';
import {contentImageSelectionRules} from './content-images.mjs';
import {contentWritingRules} from './content-writing.mjs';
import {optimizingOriginalPPT,preservePPTLayoutRule,originalPageContext} from './ppt-visual-optimization.mjs';
import {flatTypographyRule,flatPageFinishRule} from './visual-treatment.mjs';
export const designPolicyVersion='workflow-design-2026-10-11-v5';
export const splitKinds=['regular','diagonal','arc','sector','concentric','wave','pyramid','radial','disc-and-column','honeycomb','custom'];
export const designCheckKeys=['related_visual','semantic_layout','independent_text','title_hierarchy','readability','restrained_decoration','image_integrity','top_progress','academic_fill'];
export function pageNeedsImage(p,index){
  const s=p.slides[index],textOnly=s?.kind==='cover'||isTOCPage(s,index,p.brief);
  const use=s?.kind==='cover'?'hero-image':isTOCPage(s,index,p.brief)?'toc-image':null,hasBackground=use&&themeAssetsCurrent(p)&&p.themeAssets.directions?.some(d=>d.assets?.[use]?.previewReview?.status==='passed');
  return !textOnly||hasBackground||!!(s?.imageId||s?.elements?.some(n=>n.type==='image'&&n.materialId));
}
export const applicableDesignChecks=(p,index)=>designCheckKeys.filter(k=>!advisoryDesignChecks.includes(k)&&(k!=='related_visual'||pageNeedsImage(p,index)));
export function academicContext(p){const brief=[p.brief.title,p.brief.purpose,p.brief.audience].join(' ');return !/创新创业|创业|融资|商业计划|路演/.test(brief)&&/学术|科研|学位|论文|博士|硕士|毕业答辩|实验研究/.test(brief);}
export function designRulesFor(p,index,stage='design'){
  if(optimizingOriginalPPT(p))return preservePPTLayoutRule+'\n'+originalPageContext(p,index)+'\n'+materialFidelityPolicy+' 准确文字、表格和简单图形最终原生编辑；只重建当前视觉效果，不以整页截图代替可编辑页面。';
  const page=p.slides[index],academic=academicContext(p),progress=p.brief.progress!==false,backgrounds=themeAssetsReady(p);
  return `设计规范版本：${designPolicyVersion}；当前阶段：${stage}。用户明确要求优先于默认风格建议；事实与表达准确、材料原件身份、可编辑性始终保留。
${materialFidelityPolicy}
${['review','image','rebuild'].includes(stage)?lightweightReviewRule:''}
优先顺序：忠实于材料与信息完整 → 内容关系 → 可读性 → 跨页一致与空间组织 → 视觉与装饰。${presentationStyleScope}
${p.visualTreatment==='flat'&&!['review','content'].includes(stage)?flatTypographyRule+'；'+flatPageFinishRule+'。':''}
每页一个明确观点，保留必要条件、比较口径、证据与限制；内容多时先优化分组与图文组合，只精简不承载信息的赘述；不得因图片较多减少分点、合并多段正文或把必要信息只放入讲稿，不靠空卡片凑密度。并列、对照、流程、层级、包含、中心支撑等关系必须真实，不能把并列画成因果。
页面主标题是内容树固定最高根项，正文各组位于其下，主标题不参与并列。已确认表格按原有行列承载结论与数据，不强拆为正文或重复列出；未入表的各段与各分点分别作为独立文本对象，同级观点优先并列呈现，不把多段文字装入同一文本框；真实从属关系保留，由准确小标题或已能统领该组的页面标题概括；不重复加标题。段内尽量不用冒号和箭头串长文，须拆分时在内容阶段完成，已确认文案不得自行改写。正文、图注、分标题保持清楚层级。${contentNodeMeaningRule}
${stage==='content'?contentWritingRules+'\n'+contentImageSelectionRules+'\n'+imageSpacePlanningRule:'已确认的相关配图全部保留，围绕对应小标题与正文组织空间，不因版式简化而漏图或换成装饰；内容树没有配图时回到内容阶段补充，不在后续阶段擅改内容树。'}
${backgrounds?'已登记工作流视觉方向：封面/目录若有对应合格 hero-image/toc-image，则在原底图上构建，保留主体、核心底色与阅读空间；缺少时按登记风格直接生成整页，不要求补齐；底图不新增内容树图片占位节点，不新增图注。另行插入的事实原图仍独立保真回填。对应无字底图原样作为PPT页面背景，不重复拆解底图已有视觉；文字与新增承载单独可编辑。致谢可复用内容背景。':'封面/标题页（cover）和目录页（toc；旧格式按是否包含标题页确定目录位置）默认不配图，采用文字、留白与必要的几何版式，不主动新增图片节点、主题插画或照片，不把缺图列为缺口。用户明确要求配图或手动插入原图时尊重其选择。'}普通内容页安排与内容相关、可辨认的照片、图表、机理示意或主题主视觉；纯色、纹理、装饰圆点、导航与分区色块不算配图。事实图缺失必须明确列为待补材料，不能生成证据；非事实示意可生成。${imageCaptionRule}登记图片仅有一个准确图片标题或一条图注，二选一；两者都缺失时在设计稿中点名，不临时杜撰，也不因已有图片标题而再补图注。
${placeholderAspectRewriteRule}
${originalImagePlacementRule}
本页配图规则：${pageNeedsImage(p,index)?'安排内容相关视觉；若已有登记图片，必须保留原件及图注。':'默认无配图，不生成图片或要求补图；related_visual 为不适用项，可返回 true 并说明原因，验收不以缺少图片否决。'}
${deckTitleFontRule}
${stage==='review'?'':specialLayoutDesignGuidance+visualConnectionDesignRule+'不设特殊分块页数配额，不为数量牺牲内容逻辑与信息完整。尚未确认的页面不得生成，不因其他页尚未确认而阻止先生成已确认页。'}
特殊分块仅为创作要求，不作为检查项，不分类、不统计达标数量，不因常规布局或特殊分块不足而判 failed、semantic_layout=false 或写入 issues；实际语义、准确性与可读性继续检查。
检查归属：图注是否缺失属于内容树/设计稿阶段的材料缺口，在该步结束时列出，不归入 restrained_decoration。登记原图自带的白底、灰底、边框、标签与图例属于原件，不是新增装饰，不据此否决装饰克制性；禁止为满足装饰规则裁掉或改画原图。restrained_decoration 只评估本步新增的装饰是否喧宾夺主、遮挡或过量。实际图像中的遗漏、遮挡、语义改变、原图损坏与可读性问题仍须如实报告。
按语义决定有框或无框，长正文可矩形或无框，避免重复圆角卡片铺满。框高适应文字。${textBoxContrastRule}${textContrastRule}颜色以实际阅读区对比为准，不把黑白或红黄强调强制为每页标准。
${academic?'学术/论文场景：文本框内尽量不要有渐变。装饰色块内部平整填充、边界清楚；渐变仅在确有关系的块间过渡使用。有底色分标题与正文框有可辨认色差。':'按主题选择平面、摄影或立体表现；创新创业场景不机械套用学术渐变限制。'}
${['image','review'].includes(stage)?'生图只描述相对文字层级，不给具体字号。':'正文约18pt、封面标题约36pt、副标题约24pt、目录约26pt仅作设计起点。'}留白和占比用于复看，不按阈值机械否决。设计稿集中写角色字级、字重、页面可用配色、框形与装饰语言，不为标题、正文或图注逐项指定颜色；排版树只记录文案、关系、大致位置与相对大小，不写精确坐标；图片占位框的宽高由内部可读尺寸和空间预算计算，并在生图提示词明确给出，不为各文字框规定像素尺寸。生图描述相对层级，不传具体字号；不把通用可读性、简约、紧密排版或深底浅字条文附进实际生图提示词。实际重建仍记录并还原预览中观察到的准确颜色。
封面标题不套可见文本框，主题主体避开阅读区；目录条目编号与几何底座统一，同级章节名称与实际正文一致。${progressPlanningRule}
${progress?'进度条只位于页顶；封面和目录不显示。内容页使用下列现有章节原名，current=true 的章节突出；章节名来自01的进度章节配置，不按页数或逐页标题扩展节点：'+JSON.stringify(navigationTexts(p,index)):'不显示进度条。'}
底图集合无需完整性核对，不因缺少封面、目录或内容背景而否决整页；仅对实际采用的底图检查质量。
同一方向统一核心底色、字体气质、强调色语义与装饰密度；三方向应在构图、色调、文字气质、装饰和主题视觉上形成实际差异，而非只改配色。
不要过于复杂，不要抢夺视觉中心。准确文字和简单图形最终原生编辑；复杂 SVG/位图独立重建，不能整页底稿叠字。原图按占位框完整铺满，保留主体、图例、坐标和单位，不限制显示比例。实际渲染对照才能评判效果。
本页：${index+1}/${p.slides.length}，${page?.kind||'content'}，${page?.title||''}。`;
}
export function validateDesignChecks(raw){
  if(!raw||typeof raw!=='object'||designCheckKeys.some(k=>typeof raw[k]!=='boolean')||typeof raw.reason!=='string'||raw.reason.trim().length<4)throw Error('设计规范检查必须逐项返回布尔结论与实际看图依据');
  return {policyVersion:designPolicyVersion,...Object.fromEntries(designCheckKeys.map(k=>[k,raw[k]])),reason:raw.reason.trim().slice(0,2000)};
}
export const designCheckSchema='designChecks:{'+designCheckKeys.map(k=>k+':true或false').join(',')+',reason:"实际画面依据，仅说明质量问题，不检查或统计特殊分块"}';
export function designAcceptance(p,pages=p.visualPages){
  const issues=[],observed=p.slides.map((s,i)=>({index:i,checks:pages?.[i]?.designChecks}));
  for(const page of observed){const preview=pages?.[page.index]?.previewReview;if(preview&&preview.status!=='passed')issues.push(`第 ${page.index+1} 页本步视觉检查待完成或修改：${preview.issues?.join('；')||preview.status}`);const c=page.checks;if(c?.policyVersion!==designPolicyVersion){issues.push(`第 ${page.index+1} 页尚无当前规范的实际看图记录`);continue;}const failed=applicableDesignChecks(p,page.index).filter(k=>c[k]!==true);if(failed.length)issues.push(`第 ${page.index+1} 页设计规范未通过：${failed.join('、')}`);}
  return {policyVersion:designPolicyVersion,passed:issues.length===0,total:p.slides.length,issues,pages:observed};
}
