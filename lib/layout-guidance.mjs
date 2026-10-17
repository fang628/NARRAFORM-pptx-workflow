// Adapted from pptx-workflow/shared/design-principles.md; creation guidance only.
export const specialLayoutDesignGuidance='特殊分块选择：先判断本页是流程、对比、层级、并列还是中心与支撑关系，再结合文字体量、图片比例与阅读顺序判断是否适合特殊分块；适合时积极优先采用，不默认退回横带或网格。层级可探索金字塔或同心分区，中心支撑可探索放射或扇形，并列可探索蜂窝或组合分区，流程可探索波浪或阶梯；这些只是启发，不能把并列画成层级或因果。主动探索斜切、弧线以外的形态，允许调整分区数量、方向、曲率、比例及组合，同类内容可复用有效结构，不靠换色、镜像或堆装饰制造变化。layoutIntent 用1–2句说明本页关系、选择的形态及表达作用，采用常规布局时简述为何更合适；实际分区及承载落实到对应节点位置和 carrier，保留合理的局部构图发挥空间，不照抄参考图的黑线或粗框。常规横带、四宫格和背景装饰本身不是特殊分块；内容逻辑、文字可读性与原图完整性优先，不为特殊而特殊。';

export const specialLayoutImageGuidance='依已确认分块构建；适配内容时积极采用有表达作用的特殊分块，可探索扇形、同心、波浪、金字塔、放射、蜂窝及组合，不默认重复斜切或弧线；不虚构关系，不挤压文字与原图。';
export const pageCreativeDesignGuidance='页面排版须有创意：依据内容的并列、对照、流程或递进关系设计有表达作用的分区和图文组合，适合时积极采用特殊分块；layoutIntent 用1–2句说明本页创意与表达作用，避免每页机械套用同一平铺模板。';
export const roughLayoutImageGuidance='创意设计：适合内容时积极采用有表达作用的特殊分块与图文组合，以疏密和尺度变化建立重点；只给粗略创意方向，具体形状、装饰与局部组合交给生图AI，不改变内容关系或挤压文字。';
// Instructions to the prompt writer, never boilerplate for the image model.
export const creativePromptWritingRule='以下是编写提示词的方法，不是最终提示词正文：'+roughLayoutImageGuidance+'实际排版要有创意，保留合理的组合与局部构图发挥空间。请将这些原则落实为本页的一句粗略设计意图，结合实际内容关系和重点；已有设计意图时按用户意见调整，不另加创意口号，不逐字照抄或反复追加这些规则。';
export const textContrastRule='深色阅读区必须用浅色文字，浅色阅读区用深色文字；按文字所在局部底色（含文本框填充）判断，强调色也须清晰可读。';
export const textBoxContrastRule='有填充的文本框与所在背景底色须有可辨认色差，不能只靠描边区分；无框文字不强制加底。';
