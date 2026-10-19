import {openFontCatalog} from './open-font-catalog.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
let inventory;
export const artisticFontRule='书法、行楷、隶书、魏碑及艺术字也用原生text重建，保留fontFace、字号、字重、斜体、描边、阴影与渐变；禁止把可见文字改成SVG路径或抠图来假装原生文字。优先使用预览所对应且本机可用的字体，无法确定时按笔画与字形气质选接近的已安装字体，不一律换成微软雅黑。fontCategory可填calligraphy（书法）、artistic（艺术）、serif或sans。缺失字体时记录替换，不声称字形完全相同。简约方案仍不主动新增书法体，但已批准画面中的书法字须忠实还原。';
export async function availableNativeFonts({refresh=false}={}){
  if(refresh)inventory=null;
  if(!inventory)inventory=(async()=>{try{
    if(process.platform==='win32'){
      const script='[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; $fonts=New-Object System.Drawing.Text.InstalledFontCollection; @($fonts.Families | ForEach-Object { $_.Name; $_.GetName(1033); $_.GetName(2052) } | Sort-Object -Unique) | ConvertTo-Json -Compress';
      const result=await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:2_000_000});return JSON.parse(result.stdout.replace(/^\uFEFF/,''));
    }
    const result=await run('fc-list',['--format=%{family}\n'],{timeout:10000,maxBuffer:2_000_000});return [...new Set(result.stdout.split(/[\n,]/).map(s=>s.trim()).filter(Boolean))];
  }catch{return [];}})();
  return inventory;
}
const calligraphy=/行楷|行书|草书|书法|楷|隶|舒体|新魏|魏碑|毛笔|Kai|LiSu|Xing|ShuTi|calligraph|Ma\s*Shan\s*Zheng/i;
const artistic=/琥珀|彩云|姚体|综艺|海报|艺术|Hupo|Caiyun|Yaoti|decorative|ZCOOL\s*KuaiLe/i;
const aliases={'微软雅黑':'Microsoft YaHei','宋体':'SimSun','黑体':'SimHei','楷体':'KaiTi','仿宋':'FangSong','华文行楷':'STXingkai','华文楷体':'STKaiti','华文隶书':'STLiti','华文新魏':'STXinwei','方正舒体':'FZShuTi','方正姚体':'FZYaoti','隶书':'LiSu','华文琥珀':'STHupo','华文彩云':'STCaiyun'};
Object.assign(aliases,Object.fromEntries(openFontCatalog.flatMap(f=>(f.aliases||[]).map(alias=>[alias,f.family]))));
export const nativeFontFace=name=>aliases[name]||name;
const key=name=>nativeFontFace(name).replace(/[\s_-]/g,'').toLowerCase();
const managedFont=name=>openFontCatalog.find(f=>key(f.family)===key(name));
const fontCategory=name=>managedFont(name)?.category||(calligraphy.test(name)?'calligraphy':artistic.test(name)?'artistic':null);
function preferredOpenFont(e){
  const requested=e.requestedFontFace||e.fontFace||'Microsoft YaHei';
  const exact=managedFont(requested);if(exact)return exact;
  const style=e.fontCategory||fontCategory(requested);
  const family=style==='calligraphy'?(/草|Cao/i.test(requested)?'Liu Jian Mao Cao':/行书|行楷|Xing/i.test(requested)?'Zhi Mang Xing':/手写|龙藏|Long\s*Cang/i.test(requested)?'Long Cang':'Ma Shan Zheng'):style==='artistic'?(/黄油|圆|几何|QingKe/i.test(requested)?'ZCOOL QingKe HuangYou':/宋|衬线|小薇|XiaoWei/i.test(requested)?'ZCOOL XiaoWei':'ZCOOL KuaiLe'):null;
  return openFontCatalog.find(f=>f.family===family);
}
export function neededOpenFonts(elements,fonts){
  const installed=new Set(fonts.map(key)),needed=new Map();
  for(const e of elements){
    if(e.type!=='text'||installed.has(key(e.requestedFontFace||e.fontFace||'Microsoft YaHei')))continue;
    const font=preferredOpenFont(e);
    if(font&&!installed.has(key(font.family)))needed.set(font.id,font);
  }
  return [...needed.values()];
}
export function nativeFontContext(fonts){
  const selected=[...new Set([...fonts.filter(f=>fontCategory(f)),...fonts.filter(f=>/YaHei|SimSun|SimHei|DengXian|Arial|Times|Calibri|Aptos|FangSong/i.test(f)),...fonts])].slice(0,150);
  const managed=openFontCatalog.map(({family,category,style})=>({fontFace:family,category,style}));
  return '本机已安装字体（未列出不等于缺失）：'+JSON.stringify(selected)+(managed.length?'；以下开源字体可按需自动补齐，只选当前画面需要的字形：'+JSON.stringify(managed)+'。草书仅在已批准设计需要且文字可辨认时使用，不用于正文。':'');
}
export function resolveNativeFonts(elements,fonts){
  const changes=[];if(!fonts.length)return {elements,changes};
  const installed=new Map(fonts.map(face=>[key(face),face]));
  return {elements:elements.map(e=>{
    if(e.type!=='text')return e;
    const requested=e.requestedFontFace||e.fontFace||'Microsoft YaHei';
    if(installed.has(key(requested))){
      if(!e.requestedFontFace)return managedFont(requested)&&nativeFontFace(requested)!==requested?{...e,fontFace:nativeFontFace(requested)}:e;
      return {...e,fontFace:installed.get(key(requested)),requestedFontFace:undefined,fontSubstitution:undefined};
    }
    const style=e.fontCategory||fontCategory(requested);
    const openFallback=preferredOpenFont(e)?.family;
    const fallback=fonts.find(f=>openFallback&&key(f)===key(openFallback))||fonts.find(f=>style&&fontCategory(f)===style)||fonts.find(f=>key(f)===key('Microsoft YaHei'))||fonts[0];
    const change={key:e.key,requested,used:fallback,reason:'请求字体未在本机字体目录中找到，按字形类别选择可用字体'};changes.push(change);
    return {...e,fontFace:fallback,requestedFontFace:requested,fontSubstitution:change};
  }),changes};
}
