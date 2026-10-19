import {backgroundSubjectRule} from './theme-subject-policy.mjs';
import {presetPaletteRule} from './preset-design.mjs';
export const visualTreatments=['flat','realistic'];
export const flatTypographyRule='标题与正文采用简洁黑体或无衬线体，避免书法体、毛笔字和手写体';
export const flatBackgroundSubjectRule=backgroundSubjectRule;
export const flatPageFinishRule='文字无渐变；色块与文本框用平整填充，避免渐变';
export function normalizeVisualTreatment(value){
  if(value==null||value==='')return 'flat';
  if(!visualTreatments.includes(value))throw Error('请选择简约平面或写实／立体');
  return value;
}
export function visualTreatmentText(value){
  if(value==='flat')return '背景与装饰用简洁平面色块、点阵，避免复杂渐变与光影';
  if(value==='realistic')return '使用写实材质或立体造型，以体积、质感和自然光影表现主体';
  return '';
}
// Internal writing guidance; the image brief contains only the selected rendering language.
export const visualTreatmentPlanningRule='简约与写实采用完全相同的主体选取要求，不要求简约主体必须平面化；封面主体是PPT核心对象的艺术化表达，可夸张、重组或分层，不要求写实复刻，须有可画出的鲜明主题特征，不能用通用面板或普通物件敷衍；目录意象必须符合主题及全篇主线，可艺术化或抽象，不受封面对象限制；内容背景不要求主体。flat仅约束背景、装饰和页内信息的表现：背景与装饰使用平面简约色块、点阵，避免复杂渐变、光影；文字无渐变、不用书法体，色块与文本框避免渐变。realistic采用写实或立体表现。以上用于风格规划，实际提示词保持现有模板的分段与字段顺序，在对应表现或风格字段压缩为本张需要的一两句，不新增规范段落，不照抄规范段落。底图与整页预览统一采用所选类型。完整继承时仅选择与该类型相容的预设，不把不相容的整套设计改造成另一类型；配色单独按主题评估，可只借配色；其余设计原创登记。两种类型是独立选择，不把两套要求混写。底图不预画信息排版：目录文字区留空且无文本框；内容背景中央大片留空，不画分框、卡片、分栏或区域分隔线。实际生图提示词明确写具体主体对象名和绘画表现，不写已登记的风格名或预设名称。';

export function visualTreatmentContext(p){return p.visualTreatment?visualTreatmentPlanningRule+(p.visualTreatment==='flat'?flatTypographyRule+'；'+flatPageFinishRule+'。含书法字体的预设不整套继承，可只借合适配色并登记新设计。'+flatBackgroundSubjectRule+presetPaletteRule:'')+"\n当前表现类型：visualTreatment="+p.visualTreatment+"；"+visualTreatmentText(p.visualTreatment)+"。":"";}
