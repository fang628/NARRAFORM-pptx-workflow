export const restrainedIconRule='图标使用克制，仅在有明确识别或说明作用时少量采用；不为每个标题、分点或卡片机械配图标，不用无关图标填空，优先让文案、分块与图文关系表达信息。';
export const creativeStyleDisclosureRule='风格要求只说明本页实际采用的创意排版：有创意设计时必须用一句短句说明具体文本框或分块的形态与用途；没有创意设计时省略该项，不把常规分区称为创意，不根据并列、流程等内容关系臆造已选形态，不补泛泛的创意口号。图标造型、背景装饰和进度条不算页内创意排版。';
export const activeCreativeDesignRule='设计阶段必须积极寻找并采用能提升表达效果的创意排版，优先考虑文本框形态、内容分块及图文组合，不能把常规横带或网格作为默认答案。先比较适合本页关系与信息体量的方向，选定后落实到 layoutIntent、节点 position/carrier 和 style；不能只列建议或换图标。只有确实不适合时才采用常规布局，并在设计稿中简述原因。提示词中没有创意说明不代表设计阶段可以省略创意选择；有实际创意必须明确说明，没有则不写套话。保持内容关系、信息完整与图片阅读空间，不以创意不足作为检查失败项。';
// Adapted from pptx-workflow/shared/design-principles.md; creation guidance only.
export const specialLayoutDesignGuidance=activeCreativeDesignRule+'创意设计指文本框、文字承载和内容分块的形态与组合，不以图标造型创新或装饰堆叠代替版式创意；图标仅辅助表达。'+restrainedIconRule+'特殊分块选择：先判断本页是流程、对比、层级、并列还是中心与支撑关系，再结合文字体量、图片比例与阅读顺序判断是否适合特殊分块；适合时必须采用，不默认退回横带或网格。层级可探索金字塔或同心分区，中心支撑可探索放射或扇形，并列可探索蜂窝或组合分区，流程可探索波浪或阶梯；这些只是启发，不能把并列画成层级或因果。斜切可用于对照、转折或图文分隔，弧线可用于历程串联、中心围合或层次呼应；与其他形态一起按内容选用，允许调整分区数量、方向、曲率、比例及组合，同类内容可复用有效结构，不靠换色、镜像或堆装饰制造变化。layoutIntent 用1–2句说明本页关系、选择的形态及表达作用，采用常规布局时简述为何更合适；实际分区及承载落实到对应节点位置和 carrier，保留合理的局部构图发挥空间，不照抄参考图的黑线或粗框。常规横带、四宫格和背景装饰本身不是特殊分块；内容逻辑、文字可读性与原图完整性优先，不为特殊而特殊。';

export const specialLayoutImageGuidance='依已确认分块构建；适配内容时必须采用有表达作用的特殊分块，可探索斜切、弧线、扇形、同心、波浪、金字塔、放射、蜂窝及组合，不机械重复单一形态；不虚构关系，不挤压文字与原图。';
export const visualConnectionDesignRule='这是设计与提示词编写要求，不是生图提示词正文：先理解文段语义，只有实际流程、递进或因果才加箭头，不能从列表顺序或“支撑”等关键词臆造因果；并列不连箭头。直接在 logic 中用自然语言简述哪些具体内容之间加哪种箭头、表达什么联系，例如“样本处理”与“指标检测”之间加直箭头，表示处理后的检测流程；名称须来自本页实际小标题或正文短语，不使用内部标签或泛称。整页箭头集中写一次，不另设起止点登记表、连接字段或节点编号清单。最终视觉关系项仅保留这些具体箭头指令及简短含义，不粘贴通用原则或罗列全部形态。';
export const pageCreativeDesignGuidance=activeCreativeDesignRule+'页面排版须有创意：创意对象是文本框和内容分块，而非图标；依据内容的并列、对照、流程或递进关系设计有表达作用的分区和图文组合，适合时必须采用特殊分块；例如箭形表现流程、金字塔表现分级、波浪表现历程、斜切组织对照、弧线围合中心，按本页实际语义选择一种粗略方向，不逐页堆全套例子；layoutIntent 用1–2句说明本页创意与表达作用。结合实际文段关系、文字量与图片空间判断，确定适合的方向必须落实到 layoutIntent、节点 position/carrier 和 style，不写成“可尝试”“可探索”等备选建议；多个方向均适合时选表达作用最强的一种，避免每页机械套用同一平铺模板。'+restrainedIconRule+visualConnectionDesignRule;
export const roughLayoutImageGuidance='创意设计：适合内容时必须采用有表达作用的特殊分块与图文组合，以疏密和尺度变化建立重点；只给粗略创意方向，文本框轮廓、分块衔接与局部组合交给生图AI，不改变内容关系或挤压文字。';
// Instructions to the prompt writer, never boilerplate for the image model.
export const creativePromptWritingRule='以下仅供提示词编写：保留已确认的创意方向及表达作用；用户调整排版时按实际关系选定一个适合的方向，适合时必须采用特殊分块，不能只列备选或换图标。完整预设沿用其框形与分块语言。排版项仅说明内容分组与区域，不重复创意段；风格项用有主语的一句“创意设计”说明实际形态与用途，没有创意设计时省略该项。不复制预设候选目录、设计理由或通用口号。视觉关系只写具体内容之间的箭头、形态、方向及含义，无连接则写“不加箭头”，不把阅读路线画成连接。';

import {withoutColorAssignments} from './prompt-colors.mjs';
const selectedShape=/金字塔|蜂窝|扇形|同心|放射|波浪|阶梯|斜切|弧线|弧形|环形|楔形|交错|错位|错层|叠层|层叠|竖塔|三联|基座|切角|镂空|异形|特殊分块|箭形/;
// Keep complete clauses: commas often separate a subject from its drawing instruction.
function layoutClauses(value){
  return String(value||'').split(/选此方向(?:是因为|的原因)|选择依据[：:]/)[0].split(/[。；;\n]/).map(c=>c.trim())
    .map(c=>c.replace(/([^，。；]+?)不做[^，。；]+，而以/g,'$1以')
      .replace(/(?:^|，)(?:不要|不用|避免(?:使用)?|不采用)[^，]+(?=，|$)/g,'').replace(/^[，\s]+|[，\s]+$/g,'')
      .replace(/^(?:创意设计|创意方向)[：:]\s*/,''))
    .filter(c=>c&&!/^(?:选此|选择|原因|因为|可尝试|可探索|可采用|可以|建议|适合时|适合内容时)/.test(c));
}
const isSelectedShape=c=>selectedShape.test(c)&&!/不适合|不适用|不宜|无需|没有|无(?:创意|特殊|异形)|不需要|未采用|未使用/.test(c)&&
  !/图标|icon|装饰|进度条|导航/i.test(c)&&!(/箭形/.test(c)&&/连接|箭头/.test(c)&&!/分区|分块|文本框|承载|组合/.test(c));
export function pageLayoutInstructions(plan){
  const clauses=layoutClauses(plan?.layoutIntent);
  return clauses.filter(c=>!isSelectedShape(c)).join('；');
}
export function creativeLayoutHint(plan){
  const intent=layoutClauses(plan?.layoutIntent).filter(isSelectedShape);
  // Only consult legacy style/carriers if the page has not selected a shape.
  // A preset layout is an option catalog, never a selected page instruction.
  const fallback=intent.length||/不适合|不采用|不要|不用|避免/.test(plan?.layoutIntent||'')?[]:
    layoutClauses(plan?.style).filter(isSelectedShape);
  const carriers=intent.length||fallback.length||/不适合|不采用|不要|不用|避免/.test(plan?.layoutIntent||'')?[]:(plan?.nodes||[]).flatMap(n=>layoutClauses(n.carrier)).filter(isSelectedShape);
  return [...new Set(intent.length?intent:(fallback.length?fallback:carriers).map(withoutColorAssignments))].join('；');
}
export function creativeStyleInstruction(plan,options={}){
  const hint=creativeLayoutHint(plan,options);
  return hint?'创意设计：'+hint.replace(/[。；;]+$/,'')+'。':'';
}
export function visualConnectionInstruction(plan,nodes=[]){
  const describe=value=>{
    let text=String(value||'');
    for(const n of [...nodes].sort((a,b)=>b.id.length-a.id.length)){
      const content=String(n.type==='text'?n.text:n.label||'').trim().replace(/\r?\n/g,' / ').replace(/[“”]/g,'"');
      if(content)text=text.replace(new RegExp('(?<![\\w-])'+n.id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?![\\w-])','g'),'“'+content+'”');
    }
    return arrowInstructionsOnly(text);
  };
  // The model writes one natural-language arrow arrangement in the existing
  // design prose. Legacy per-node descriptions are a fallback, never a registry.
  return describe(plan?.logic)||describe((plan?.nodes||[]).map(n=>n.relation).filter(Boolean).join('；'))||'不加箭头。';
}

export const legacyVisualConnectionInstructions=[
  '实际逻辑联系用直箭头、弯箭头或箭形连接，方向与起止对应内容；并列项不画成因果。',
  '若有实际逻辑联系，用直箭头、弯箭头或箭形表达；纯并列不强加方向。'
];
// Split only outside quotations: endpoint text may itself contain punctuation.
export function arrowInstructionsOnly(text){
  for(const rule of legacyVisualConnectionInstructions)text=text.replaceAll(rule,'');
  const clauses=[],quotes=[];let current='';
  for(const c of text){
    if(c===quotes.at(-1))quotes.pop();
    else if(c==='“'||c==='「'||c==='『')quotes.push({'“':'”','「':'」','『':'』'}[c]);
    else if(c==='"'&&!quotes.length)quotes.push('"');
    if(!quotes.length&&/[。；\n]/.test(c)){clauses.push(current);current='';}else current+=c;
  }
  clauses.push(current);
  const arrows=clauses.map(c=>c.trim().replace(/^[-*]\s*/,''))
    .filter(c=>/箭头|箭形|[→⇒↔]/.test(c)&&!/^(?:若有(?:实际)?逻辑联系|实际逻辑联系|方向与起止对应内容|并列项不画成因果|纯并列不强加方向)/.test(c))
    .filter(c=>!/阅读(?:路线|路径|顺序)|顺序阅读|先读|先看|再读|再看/.test(c)||/加.*箭头|画.*箭头|用.*箭头/.test(c));
  if(arrows.length&&arrows.every(c=>!/加|画|用|连接|指入|指向|从|之间|[→⇒↔]/.test(c)||/不加|不连|不画|无.*箭头/.test(c)))return '不加箭头。';
  return [...new Set(arrows)].join('；')+(arrows.length?'。':'');
}
export const textContrastRule='深色阅读区必须用浅色文字，浅色阅读区用深色文字；按文字所在局部底色（含文本框填充）判断，强调色也须清晰可读。';
export const textBoxContrastRule='有填充的文本框与所在背景底色须有可辨认色差，不能只靠描边区分；无框文字不强制加底。';
