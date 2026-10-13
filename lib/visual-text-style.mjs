export const visualTextStyleRule='逐项观察预览的实际字体气质、字高、字重、斜体及行距；不要统一套用默认字号。size用1600×900逻辑画布中的数字字号（12–110），不是1920×1080图片像素或PowerPoint pt；fontFace填实际字体名称，无法确定时选最接近且本机可用的字体；bold/italic用true或false。每个准确nodeId单独输出一个text对象，text直接复制准确文字，包括换行、标点和空格。不要从预览图OCR改写文案。';

export function visualTextStyle(e,role){
  const invalid=(field,value)=>{const error=Error(`原生文字样式无效（元素 ${e.key} · ${field}：${JSON.stringify(value)?.slice(0,100)}）；size须为数字字号，bold须为布尔值`);error.code='INVALID_VISUAL_TEXT_STYLE';throw error;};
  let size=e.size??e.fontSize;
  if(typeof size==='string'){
    const match=size.trim().match(/^(\d+(?:\.\d+)?)\s*(px|pt)?$/i);
    if(!match)invalid('size',size);
    size=Number(match[1])/(match[2]?.toLowerCase()==='pt'?.6:1);
  }
  if(size===undefined||size===null)size=role==='title'?44:role==='heading'?30:role==='caption'?20:26;
  if(typeof size!=='number'||!Number.isFinite(size)||size<=0||size>900)invalid('size',e.size??e.fontSize);
  // The logical canvas is larger than the physical slide. Bound extreme sizes
  // to the existing native text range; actual layout is still rendered/reviewed.
  size=Math.max(12,Math.min(110,size));
  let bold=e.bold??e.fontWeight;
  if(bold===undefined||bold===null)bold=['title','heading'].includes(role);
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
    const aliases={'微软雅黑':'Microsoft YaHei','宋体':'SimSun','黑体':'SimHei','楷体':'KaiTi','仿宋':'FangSong','等线':'DengXian','sans-serif':'Microsoft YaHei','serif':'SimSun','monospace':'Consolas'};
    extra.fontFace=aliases[first]||first;
  }
  if(e.italic!==undefined){let italic=e.italic;if(typeof italic==='string'&&['true','false'].includes(italic.trim().toLowerCase()))italic=italic.trim().toLowerCase()==='true';if(typeof italic!=='boolean')invalid('italic',e.italic);extra.italic=italic;}
  return {size,bold,...extra};
}
