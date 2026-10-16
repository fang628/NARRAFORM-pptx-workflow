// Presentation styling is independent of the tool's frontend appearance.
export const presentationStylePolicyVersion='workflow-style-scope-v1';
export const presentationThemeFitPolicy='风格预设指风格库 A–F 的视觉风格，按字体气质、装饰语言、图像表现与题材判断，不是配色预设或强制版式。符合主题的风格预设必须用，三方向仍须采用不同色系，可在同一预设内适配配色。主题适配优先：先依据材料中的具体研究对象、行业场景、表达目的与受众选择视觉语言，不能只因配色好看、名称相似或加上主题主体就判定风格适合。逐一评估预设的适用题材、字体气质、装饰与图像语言，排除与主题或场景冲突的风格。三种方向可以采用同一合适预设，以构图、层级和图片策略区分，不为凑齐三个不同预设、追求反差或套用网页工业风选择不合主题的风格。预设符合材料主题且与用途、受众及视觉语言不冲突时必须使用，并登记参考编号；配色与构图可在预设内适配，不以尚需局部调整为由跳过。没有符合主题的预设或用户明确另选时才原创并登记，不能把仅配色相似误判为主题适配。每个方向的适配理由用一句话说明材料主题与具体视觉选择的联系，不能只写“适合主题”。更换风格与项目已登记风格复用同样先判断适配，指定参考也不能绕过主题适配。';
export const presentationStyleScope=`风格作用域：网页前端的工业风、终末地美学、黑白黄、亮黄色、点阵、等高线与电路线阵仅用于工具界面，不构成 PPT 需求，不从界面、示例或旧设计推断用户的 PPT 配色偏好。PPT 依据 pptx-workflow 风格库与规范库，按材料主题、用途和受众选型；只有当前 PPT 需求明确指定的视觉偏好才作为例外。工业题材本身也不等于必须使用工业风。`;
export function presentationDirectionStyle(direction){
  return `${presentationStyleScope}\n本页采用的 PPT 方向：${direction.style}。本方向统一控制核心底色、强调色、字体气质、框形填充描边与装饰语言；单页设计稿仅提供内容、关系、布局与可读性意图，若其旧配色或装饰描述冲突，以本方向为准，不混入其他方向的风格。`;
}
