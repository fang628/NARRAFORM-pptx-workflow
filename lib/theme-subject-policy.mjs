import {backgroundUsesForBrief} from './page-options.mjs';

export const backgroundSubjectRule='底图主体是艺术化的视觉表达，可采用抽象形态、意象、光影、材质、AI生成的物品或人物等具象对象，生成的物品或人物只作艺术主体，不冒充材料里的真实人物、照片或证据。不要求是主题对应的具体物质，也不要求在材料中出现。有明确主题时，艺术意象必须符合主题并贯穿全篇材料的共同主线；没有明确主题且有实际照片时，优先以材料照片主体建立统一视觉锚点，先综合材料总述、各章节与逐页内容选择，不能只代表某一小节或局部案例；不要求每页重复同一物体，不把装饰画面声称为实验原图、真实构象或材料证据。每张有清楚的视觉重心，文字区留白，可搭配少量艺术点缀。';
export const backgroundVariationRule='任何风格（含完整预设、预设配色借用、简约平面、写实／立体）的封面与目录底图，在主体、主体形状或视觉效果三者中至少有一项明显不同；可以换主体，也可对同一意象改变形态、材质或光影，不只把同一主体挪位置或镜像。整套配色与设计语言一致，不等于两张画面复刻。';
const visualKey=value=>String(value||'').toLowerCase().replace(/水平翻转|垂直翻转|镜像|翻转|封面|目录|底图|同一|相同|主体|位于|置于|放在|居中|左半区|右半区|左侧|右侧|左下角?|右下角?|左上角?|右上角?|边侧|边角|位置|区域|画面|[\s，,。；;：:、（）()“”"']/g,'');
// Repair only an obviously repeated planning description; never reject a generated image.
export function distinguishBackgroundVisuals(direction,brief={},treatment){
  const uses=backgroundUsesForBrief(brief);
  if(!uses.includes('hero-image')||!uses.includes('toc-image'))return {...direction};
  const hero=visualKey(direction.heroSubject),toc=visualKey(direction.tocSubject);
  if(!hero||!toc||hero!==toc)return {...direction};
  const effect=treatment==='realistic'?'以分层透光轮廓与交错光影呈现':'以错位叠片重组轮廓';
  return {...direction,tocSubject:String(direction.tocSubject).replace(/[。；;\s]+$/u,'')+'，'+effect};
}
