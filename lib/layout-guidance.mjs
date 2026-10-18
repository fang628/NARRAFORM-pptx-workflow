// Adapted from pptx-workflow/shared/design-principles.md; creation guidance only.
export const specialLayoutDesignGuidance='特殊分块选择：先判断本页是流程、对比、层级、并列还是中心与支撑关系，再结合文字体量、图片比例与阅读顺序判断是否适合特殊分块；适合时必须采用，不默认退回横带或网格。层级可探索金字塔或同心分区，中心支撑可探索放射或扇形，并列可探索蜂窝或组合分区，流程可探索波浪或阶梯；这些只是启发，不能把并列画成层级或因果。斜切可用于对照、转折或图文分隔，弧线可用于历程串联、中心围合或层次呼应；与其他形态一起按内容选用，允许调整分区数量、方向、曲率、比例及组合，同类内容可复用有效结构，不靠换色、镜像或堆装饰制造变化。layoutIntent 用1–2句说明本页关系、选择的形态及表达作用，采用常规布局时简述为何更合适；实际分区及承载落实到对应节点位置和 carrier，保留合理的局部构图发挥空间，不照抄参考图的黑线或粗框。常规横带、四宫格和背景装饰本身不是特殊分块；内容逻辑、文字可读性与原图完整性优先，不为特殊而特殊。';

export const specialLayoutImageGuidance='依已确认分块构建；适配内容时必须采用有表达作用的特殊分块，可探索斜切、弧线、扇形、同心、波浪、金字塔、放射、蜂窝及组合，不机械重复单一形态；不虚构关系，不挤压文字与原图。';
export const visualConnectionDesignRule='这是设计与提示词编写要求，不是生图提示词正文：先理解文段语义，只有实际流程、递进或因果才加箭头，不能从列表顺序或“支撑”等关键词臆造因果；并列不连箭头。直接在 logic 中用自然语言简述哪些具体内容之间加哪种箭头、表达什么联系，例如“样本处理”与“指标检测”之间加直箭头，表示处理后的检测流程；名称须来自本页实际小标题或正文短语，不使用内部标签或泛称。整页箭头集中写一次，不另设起止点登记表、连接字段或节点编号清单。最终视觉关系项仅保留这些具体箭头指令及简短含义，不粘贴通用原则或罗列全部形态。';
export const pageCreativeDesignGuidance='页面排版须有创意：依据内容的并列、对照、流程或递进关系设计有表达作用的分区和图文组合，适合时必须采用特殊分块；例如箭形表现流程、金字塔表现分级、波浪表现历程、斜切组织对照、弧线围合中心，按本页实际语义选择一种粗略方向，不逐页堆全套例子；layoutIntent 用1–2句说明本页创意与表达作用。结合实际文段关系、文字量与图片空间判断，确定适合的方向必须落实到 layoutIntent、节点 position/carrier 和 style，不写成“可尝试”“可探索”等备选建议；多个方向均适合时选表达作用最强的一种，避免每页机械套用同一平铺模板。'+visualConnectionDesignRule;
export const roughLayoutImageGuidance='创意设计：适合内容时必须采用有表达作用的特殊分块与图文组合，以疏密和尺度变化建立重点；只给粗略创意方向，具体形状、装饰与局部组合交给生图AI，不改变内容关系或挤压文字。';
// Instructions to the prompt writer, never boilerplate for the image model.
export const creativePromptWritingRule='以下是编写提示词的方法，不是最终提示词正文：'+roughLayoutImageGuidance+'实际排版要有创意，保留合理的组合与局部构图发挥空间。按语义可用箭形表现流程、金字塔表现分级、波浪表现历程、斜切组织对照、弧线围合中心，最终仅写适合本页的一个方向，已判断适合的方向必须采用并以明确绘图指令写入风格要求，不弱化成可选或探索建议；确实不适合时才采用常规分区并在设计稿中简述原因，不照贴全部例子。'+visualConnectionDesignRule+'创意设计要求放在最终提示词的风格要求中，参照特殊分块规范，按本页关系选择有表达作用的分块、异形承载与图文组合；以疏密和尺度突出重点，保留局部构图发挥空间。完整预设沿用原有分块和框形。排版项只交代主要分组、区域与阅读顺序，不重复创意段。请将这些原则落实为本页的一句粗略设计意图，结合实际内容关系和重点；已有设计意图时按用户意见调整，不另加创意口号，不逐字照抄或反复追加这些规则。';

// Infer only from design meaning, never from internal labels or source quotations.
function layoutMeaning(plan){return [plan?.logic,plan?.layoutIntent].filter(Boolean).join('；').replace(/(?:不|无|非|没有|不存在|不宣称|不表示|不构成|不得新增|不新增)(?:具有|存在|任何|额外|真实)?(?:因果|流程|反馈|递进|层级|分级)(?:关系|联系|箭头)?/g,'');}
export function creativeLayoutHint(plan,{preset=false}={}){
  const text=layoutMeaning(plan);
  if(/历程|演进|时间线|发展阶段/.test(text))return preset?'以波浪走向串联历程，保留预设分区':'以波浪走向表现历程';
  if(/分级|层级|等级|金字塔/.test(text))return preset?'以尺度梯度突出分级，保留预设分区':'以金字塔式分区表现分级';
  if(/流程|步骤|先后|路径|递进|阶段/.test(text)){
    const relation=/递进/.test(text)&&!/流程|步骤|先后|路径/.test(text)?'递进':'流程';
    return preset?'以箭形连接强化'+relation+'，保留预设分区':'以箭形组合表现'+relation;
  }
  return '以形态与尺度变化突出重点';
}
export function creativeStyleInstruction(plan,{preset=false}={}){
  if(preset)return '创意设计：沿用预设的分块、框形与装饰，通过图文组合及疏密、尺度变化强化重点。';
  const text=layoutMeaning(plan);let hint=creativeLayoutHint(plan);
  const clauses=String(plan?.layoutIntent||'').split(/[，。；;]/),negative=c=>/(?:不使用|不采用|不要|避免|不用)/.test(c),rejected=clauses.filter(negative).join('；');
  if(/(?:不适合|不适用|不宜)(?:采用|使用)?(?:特殊|异形|创意)?分块/.test(String(plan?.layoutIntent||''))&&/常规|普通|简单/.test(text))return '创意设计：采用已确认的常规分区，通过图文组合、疏密与尺度变化突出重点。';
  const selected=clauses.filter(c=>!negative(c)).join('；').match(/金字塔|蜂窝|扇形|同心|放射|波浪|阶梯|斜切|弧线|弧形|环形|楔形/);
  if(selected)hint='沿用已确认的'+selected[0]+'分区';
  if(hint==='以形态与尺度变化突出重点')hint=/对照|对比/.test(text)?(/斜切/.test(rejected)?'以交错分区与组合承载组织对照':'以斜切分区组织对照'):/中心|支撑/.test(text)?(/弧线|弧形/.test(rejected)?'以放射式图文分区突出中心与支撑':'以弧线围合组织中心与支撑'):/并列/.test(text)?'以组合分区组织并列图文':hint;
  return '创意设计：'+hint+'，采用有表达作用的特殊分块、异形承载与图文组合，以疏密和尺度变化建立重点。';
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
    .filter(c=>/箭头|箭形|[→⇒↔]/.test(c)&&!/^(?:若有(?:实际)?逻辑联系|实际逻辑联系|方向与起止对应内容|并列项不画成因果|纯并列不强加方向)/.test(c));
  return [...new Set(arrows)].join('；')+(arrows.length?'。':'');
}
export const textContrastRule='深色阅读区必须用浅色文字，浅色阅读区用深色文字；按文字所在局部底色（含文本框填充）判断，强调色也须清晰可读。';
export const textBoxContrastRule='有填充的文本框与所在背景底色须有可辨认色差，不能只靠描边区分；无框文字不强制加底。';
