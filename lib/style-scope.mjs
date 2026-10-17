// Presentation styling is independent of the tool's frontend appearance.
export const presentationStylePolicyVersion='workflow-style-scope-v2';
export const presentationThemeFitPolicy='风格预设指风格库 A–F 的完整视觉设计，按字体气质、装饰语言、图像表现与题材判断。主题适配优先：不能只因配色好看、名称相似或加上主题主体就判定适合；预设符合材料主题且与用途、受众不冲突时必须采用。选中后原样复用预设配色、渐变、字体、字效、框形、装饰和页型版式规则，只替换当前材料的内容与主体；不得为三方向色差自动改色、改字或重设计。全套封面、目录、内容页统一使用该方向核心底色，不按页型切换底色，其余预设设计保留。三种方向可以采用同一合适预设，保留原设计，不为凑不同色系选择不合主题的风格。没有符合主题的预设或用户明确另选时才原创并登记；原创风格仍采用不同色系。更换风格与项目已登记风格复用同样先判断适配，指定参考也不能绕过主题适配。以上完整继承规则仅适用于 referenceStyleId；简约平面可独立评估并优先复用适合主题的预设配色，用 paletteReferenceId 记录，其他设计另行登记，不被迫继承预设字体、装饰和写实表现。';
export const presentationStyleScope=`风格作用域：网页前端的工业风、终末地美学、黑白黄、亮黄色、点阵、等高线与电路线阵仅用于工具界面，不构成 PPT 需求，不从界面、示例或旧设计推断用户的 PPT 配色偏好。PPT 依据 pptx-workflow 风格库与规范库，按材料主题、用途和受众选型；只有当前 PPT 需求明确指定的视觉偏好才作为例外。工业题材本身也不等于必须使用工业风。`;
export function presentationDirectionStyle(direction){
  return `${presentationStyleScope}\n本页采用的 PPT 方向：${direction.style}。本方向统一控制核心底色、强调色、字体气质、框形填充描边与装饰语言；单页设计稿仅提供内容、关系、布局与可读性意图，若其旧配色或装饰描述冲突，以本方向为准，不混入其他方向的风格。`;
}
