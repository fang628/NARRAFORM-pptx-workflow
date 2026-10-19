import {backgroundUsesForBrief} from './page-options.mjs';

export const coverSubjectArtRule='封面主体采用PPT核心对象的艺术化表达，不要求写实复刻原貌；先理解材料实际介绍的对象及其特有关系或能力，再选择能被画出来的鲜明形象。允许夸张、重组、分层、悬浮或形态转译，但保留让人联想到主题的识别特征，仍组织成一个主要艺术对象。不要把单张页面、玻璃面板、通用界面或普通物件默认当成主体；材质不是主体特征。材料介绍文稿或软件时，可将其特有能力转译为有辨识度的艺术形象，不只复刻空白窗口与框位，也不对所有题材套用同一文稿图层形象。提示词只写所选形象及一两项可画特征，不写登记原图、原生形状、仅表现框位等程序术语，不靠文字标签说明主体，也不展开为完整界面设计。';
export const backgroundSubjectRule='只有封面底图必须明确指名一个可辨识的具象艺术主体，以PPT实际介绍的核心对象为依据，贯穿全篇材料的共同主线。'+coverSubjectArtRule+'该主体必须符合主题并贯穿全篇材料的共同主线，不能只代表某一小节或局部案例；艺术转译不编造实验结论、精确构象或把生成图声称为原始证据。没有明确主题且有实际照片时，优先以材料照片实际介绍的对象为艺术表达依据。每张仅一个主要对象，可搭配少量主题陪衬，不形成第二个竞争主体。目录页视觉表达必须符合PPT主题并呼应全篇主线，可艺术化或抽象，不强制采用封面的核心具象对象或其鲜明特征；内容页背景不强制主体，只需延续配色、装饰与留白。';
export const backgroundVariationRule='任何风格（含完整预设、预设配色借用、简约平面、写实／立体）的封面与目录底图，在主体、主体形状或视觉效果三者中至少有一项明显不同；封面保持对核心主题的辨识特征，允许艺术转译，目录可采用其他贴合全篇主题的视觉意象，两页可以改变形态、视角或视觉效果，不只把同一主体挪位置或镜像。整套配色与设计语言一致，不等于两张画面复刻。';
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
