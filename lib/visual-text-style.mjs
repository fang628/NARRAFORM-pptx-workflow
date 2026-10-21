import {deckTitleFontRule} from './title-fonts.mjs';
import {textSpacing,textSpacingRule} from './text-spacing.mjs';
import {nativeEffectsRule} from './native-effects.mjs';
import {artisticFontRule,nativeFontFace} from './native-fonts.mjs';
export const visualTextStyleRule='逐项观察预览的实际字体气质、字高、字重、斜体及行距；不要统一套用默认字号。size用1600×900逻辑画布中的数字字号（20–110），不是1920×1080图片像素或PowerPoint pt；fontFace填实际字体名称，无法确定时选最接近且本机可用的字体；bold/italic用true或false；逐项识别原生斜体，字体族与斜体属性分开记录，不用倾斜文本框代替。每个准确nodeId的文案完整保留，通常输出一个text对象，目录/小标题编号按独立拆分规则处理，text直接复制准确文字，包括换行、标点和空格。不要从预览图OCR改写文案。字号先保证可读性：正文通常26–32逻辑单位（15.6–19.2pt），标题按层级放大，图注和辅助文字不得低于20逻辑单位（12pt）。内容放不下时优先调整文本框、换行、疏密和分区，不以过小字号强塞；以实际PowerPoint渲染核对字高、行距及出框。'+textSpacingRule+nativeEffectsRule+artisticFontRule+deckTitleFontRule;

export function visualTextStyle(e,role){
  const invalid=(field,value)=>{const error=Error(`原生文字样式无效（元素 ${e.key} · ${field}：${JSON.stringify(value)?.slice(0,100)}）；size须为数字字号，bold须为布尔值`);error.code='INVALID_VISUAL_TEXT_STYLE';throw error;};
  let size=e.size??e.fontSize;
  if(typeof size==='string'){
    const match=size.trim().match(/^(\d+(?:\.\d+)?)\s*(px|pt)?$/i);
    if(!match)invalid('size',size);
    size=Number(match[1])/(match[2]?.toLowerCase()==='pt'?.6:1);
  }
  if(size===undefined||size===null)size=role==='title'?44:role==='heading'?30:role==='imageTitle'?24:role==='caption'?20:26;
  if(typeof size!=='number'||!Number.isFinite(size)||size<=0||size>900)invalid('size',e.size??e.fontSize);
  // The logical canvas is larger than the physical slide. Bound extreme sizes
  // to the existing native text range; actual layout is still rendered/reviewed.
  size=Math.max(role==='navigation'||e.role==='navigation'||e.managed==='progress'||e.managed==='footer'?.5:20,Math.min(110,size));
  const suppliedFace=e.fontFace??e.fontFamily;
  const firstFace=typeof suppliedFace==='string'?suppliedFace.split(',')[0].trim().replace(/^["']|["']$/g,'').trim():'';
  const familyStyle=firstFace.match(/(?:[\s-]+)((?:Bold[\s-]+)?(?:Italic|Oblique)|Bold)$/i);
  let bold=e.bold??e.fontWeight??(/bold/i.test(familyStyle?.[1]||'')?true:undefined);
  if(bold===undefined||bold===null)bold=['title','heading','imageTitle'].includes(role);
  if(typeof bold==='string'){
    const value=bold.trim().toLowerCase();
    if(['true','bold','bolder','semibold','semi-bold'].includes(value))bold=true;
    else if(['false','normal','regular','lighter'].includes(value))bold=false;
    else if(/^\d{1,4}$/.test(value))bold=Number(value);
  }
  if(typeof bold==='number'){
    if(bold===0||bold===1)bold=Boolean(bold);
    else if(bold>=100&&bold<=1000)bold=bold>=600;
  }
  if(typeof bold!=='boolean')invalid('bold',e.bold??e.fontWeight);
  const extra={},face=e.fontFace??e.fontFamily;
  if(face!==undefined&&face!==null){
    if(typeof face!=='string'||!face.trim()||face.length>128||/[\x00-\x1f<>]/.test(face))invalid('fontFace',face);
    const first=face.split(',')[0].trim().replace(/^["']|["']$/g,'').trim();if(!first)invalid('fontFace',face);
    const aliases={'微软雅黑':'Microsoft YaHei','宋体':'SimSun','黑体':'SimHei','楷体':'KaiTi','仿宋':'FangSong','等线':'DengXian','华文行楷':'STXingkai','华文楷体':'STKaiti','华文隶书':'STLiti','华文新魏':'STXinwei','方正舒体':'FZShuTi','方正姚体':'FZYaoti','隶书':'LiSu','华文琥珀':'STHupo','华文彩云':'STCaiyun','sans-serif':'Microsoft YaHei','serif':'SimSun','monospace':'Consolas'};
    const family=familyStyle?first.slice(0,familyStyle.index).trim():first;
    extra.fontFace=nativeFontFace(aliases[family]||family);
  }
  let italic=e.italic??e.fontStyle;
  if(italic===undefined&&/italic|oblique/i.test(familyStyle?.[1]||''))italic=true;
  if(italic!==undefined&&italic!==null){
    if(typeof italic==='string'){
      const value=italic.trim().toLowerCase();
      if(/^(true|1|italic|oblique|斜体)(?:\s+[-+]?\d+(?:\.\d+)?deg)?$/.test(value))italic=true;
      else if(['false','0','normal','regular','upright','正体'].includes(value))italic=false;
    }
    if(italic===0||italic===1)italic=Boolean(italic);
    if(typeof italic!=='boolean')invalid('italic',e.italic??e.fontStyle);
    extra.italic=italic;
  }
  if(e.fontCategory!==undefined){if(!['calligraphy','artistic','serif','sans','monospace'].includes(e.fontCategory))invalid('fontCategory',e.fontCategory);extra.fontCategory=e.fontCategory;}
  return {size,bold,...extra,...textSpacing(e,size)};
}
export {artisticFontRule};
