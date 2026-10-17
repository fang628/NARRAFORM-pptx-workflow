import {presetPaletteRule} from './preset-design.mjs';
export const visualTreatments=['flat','realistic'];
export const flatTypographyRule='标题与正文采用简洁黑体或无衬线体，避免书法体、毛笔字和手写体';
export const flatBackgroundSubjectRule='简约平面的封面与目录底图须有明确、符合全篇主题的主视觉，轮廓清楚，以足够尺度和适度层次使视觉区相对丰满，避免缩成小图标或零散装饰；保留连续文字留白，不靠堆砌无关元素填满画面。';
export function normalizeVisualTreatment(value){
  if(value==null||value==='')return 'flat';
  if(!visualTreatments.includes(value))throw Error('请选择简约平面或写实／立体');
  return value;
}
export function visualTreatmentText(value){
  if(value==='flat')return '使用简洁平面图形与色面，以轮廓、尺度和留白建立设计感';
  if(value==='realistic')return '使用写实材质或立体造型，以体积、质感和自然光影表现主体';
  return '';
}
// Internal writing guidance; the image brief contains only the selected rendering language.
export const visualTreatmentPlanningRule='选择 visualTreatment=flat 时采用简约平面表现，主体可以是抽象意象、图形或具体物体的平面化表达，不要求照片、写实材质、三维建模或体积光影；realistic 时采用写实或立体表现，不强制同时满足两者。底图与整页预览统一采用所选类型。完整继承时仅选择与该类型相容的预设，不把不相容的整套设计改造成另一类型；配色单独按主题评估，可只借配色；其余设计原创登记。两种类型是独立选择，不把两套要求混写。底图不预画信息排版：目录文字区留空且无文本框；内容背景中央大片留空，不画分框、卡片、分栏或区域分隔线。实际生图提示词明确写具体主体对象名和绘画表现，不写已登记的风格名或预设名称。';

export function visualTreatmentContext(p){return p.visualTreatment?visualTreatmentPlanningRule+(p.visualTreatment==='flat'?flatTypographyRule+'。含书法字体的预设不整套继承，可只借合适配色并登记新设计。'+flatBackgroundSubjectRule+presetPaletteRule:'')+"\n当前表现类型：visualTreatment="+p.visualTreatment+"；"+visualTreatmentText(p.visualTreatment)+"。":"";}
