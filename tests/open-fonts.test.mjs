import {prepareElementFonts} from '../lib/automatic-fonts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {openFontCatalog,installOpenFonts} from '../lib/open-fonts.mjs';
import {resolveNativeFonts,nativeFontContext,neededOpenFonts} from '../lib/native-fonts.mjs';
import {visualAction} from '../lib/visual-pipeline.mjs';
import {visualDelivery} from '../public/visual-ui.js';
import {visualTextStyle} from '../lib/visual-text-style.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function fixture(){
  const bytes=Buffer.from('synthetic font for logic tests only'),license=Buffer.from('synthetic license'),catalog=openFontCatalog.slice(0,2).map(f=>({...f,bytes:bytes.length,sha256:hash(bytes),licenseHash:hash(license)})),env={data:fs.mkdtempSync(path.resolve('work/open-fonts-')),root:path.resolve('.')},installed=[];
  let requests=0,installs=0;
  return {env,catalog,installed,counts:()=>({requests,installs}),options:{catalog,inventory:async()=>installed,fetcher:async url=>{requests++;return new Response(url.endsWith('OFL.txt')?license:bytes);},install:async font=>{installs++;installed.push(font.family);}}};
}

test('底层安装器下载指定子集、保留OFL并校验，重复调用不重复下载或安装',async()=>{
  const f=fixture(),result=await installOpenFonts(f.env,f.options);assert.equal(result.status,'done');assert.deepEqual(result.fonts.map(f=>f.status),['installed','installed']);assert.deepEqual(f.counts(),{requests:4,installs:2});
  for(const font of f.catalog)assert.ok(fs.existsSync(path.join(f.env.data,'font-cache',font.id,font.revision,'OFL.txt')));
  const again=await installOpenFonts(f.env,f.options);assert.equal(again.status,'done');assert.deepEqual(again.fonts.map(f=>f.status),['already_installed','already_installed']);assert.deepEqual(f.counts(),{requests:4,installs:2});
});

test('下载中断或校验失败不安装坏文件；其他字体继续，重试复用已校验缓存',async()=>{
  const f=fixture(),fetcher=f.options.fetcher;
  let broken=true;
  const options={...f.options,fetcher:async url=>broken&&url.includes('mashanzheng')&&!url.endsWith('OFL.txt')?new Response('corrupt'):fetcher(url)};
  const first=await installOpenFonts(f.env,options);assert.equal(first.status,'partial');assert.equal(first.fonts[0].status,'failed');assert.match(first.fonts[0].error,/校验/);assert.equal(first.fonts[1].status,'installed');assert.deepEqual(f.installed,['ZCOOL KuaiLe']);
  broken=false;const next=await installOpenFonts(f.env,options);assert.equal(next.status,'done');assert.equal(next.fonts[1].status,'already_installed');assert.equal(f.counts().installs,2);
});

test('过大响应和系统未识别不报假成功；错误或取消后可再次尝试',async()=>{
  const f=fixture(),big=await installOpenFonts(f.env,{...f.options,fetcher:async()=>new Response('bad',{headers:{'content-length':'99999999'}})});assert.equal(big.status,'partial');assert.equal(f.counts().installs,0);
  const unknown=await installOpenFonts(f.env,{...f.options,install:async()=>{}});assert.equal(unknown.status,'partial');assert.match(unknown.fonts[0].error,/系统尚未识别/);
  const controller=new AbortController();controller.abort();await assert.rejects(installOpenFonts(f.env,{...f.options,signal:controller.signal}),/abort/i);
  assert.equal((await installOpenFonts(f.env,f.options)).status,'done');
});

test('多个项目同时补齐共用安装锁，不重复请求、不丢失成功状态',async()=>{
  const f=fixture(),results=await Promise.all([installOpenFonts(f.env,f.options),installOpenFonts(f.env,f.options)]);assert.ok(results.every(r=>r.status==='done'));assert.deepEqual(f.counts(),{requests:4,installs:2});
});

test('缺失书法/艺术字按类别使用补齐字体；已明确选择的本机字体保留，原文字仍为原生text',()=>{
  const elements=[{key:'c',type:'text',fontFace:'缺失书法字',fontCategory:'calligraphy',text:'山川万象'},{key:'a',type:'text',fontFace:'缺失艺术字',fontCategory:'artistic',text:'创意表达'},{key:'known',type:'text',fontFace:'STXingkai'}],fonts=['Microsoft YaHei','STXingkai','STHupo','Ma Shan Zheng','ZCOOL KuaiLe'];
  const result=resolveNativeFonts(elements,fonts);assert.deepEqual(result.elements.map(e=>e.fontFace),['Ma Shan Zheng','ZCOOL KuaiLe','STXingkai']);assert.ok(result.elements.every(e=>e.type==='text'));assert.equal(result.elements[0].text,elements[0].text);assert.equal(result.elements[0].requestedFontFace,'缺失书法字');
  const old=resolveNativeFonts(elements,['Microsoft YaHei']);assert.equal(resolveNativeFonts(old.elements,fonts).elements[0].fontFace,'Ma Shan Zheng');assert.match(nativeFontContext(fonts),/Ma Shan Zheng/);
});

test('原字体之后可用时恢复原选择，替换记录不会覆盖新的显式字体选择',()=>{
  const old={key:'t',type:'text',fontFace:'Microsoft YaHei',requestedFontFace:'原书法字',fontSubstitution:{requested:'原书法字',used:'Microsoft YaHei'}};
  const result=resolveNativeFonts([old],['Microsoft YaHei','原书法字']);assert.equal(result.elements[0].fontFace,'原书法字');assert.equal(result.elements[0].fontSubstitution,undefined);
  assert.match(fs.readFileSync('lib/rebuild-tools.mjs','utf8'),/delete e.requestedFontFace/);
});

test('05无手动字体入口，自动补齐失败状态可见且转义',()=>{
  const p={visualMode:'ai',approvals:{preview:1},version:1,fullPreviewPages:[true],slides:[{title:'单页'}],task:{status:'running'},openFontSupport:{mode:'automatic',fonts:[{label:'字体',status:'failed',error:'<网络异常>'}]}};
  const html=visualDelivery(p,()=>'',()=>'',(...args)=>args.join(''));assert.doesNotMatch(html,/installOpenFonts|一键补齐|type="file"/);assert.match(html,/字体按需自动补齐/);assert.match(html,/&lt;网络异常&gt;/);
});

test('旧的手动安装动作已移除',async()=>{
  assert.equal(await visualAction({},{action:'installOpenFonts'},{}),false);
});

test('按实际字体需求选子集，别名去重，普通文字与已有字体不下载',()=>{
  const text=fontFace=>({type:'text',fontFace});
  assert.deepEqual(neededOpenFonts([text('Arial'),text('Ma Shan Zheng'),text('马善政毛笔楷书'),{type:'image',fontFace:'ZCOOL KuaiLe'}],['Arial']).map(f=>f.family),['Ma Shan Zheng']);
  assert.deepEqual(neededOpenFonts([text('Ma Shan Zheng')],['Ma Shan Zheng']),[]);
  assert.deepEqual(neededOpenFonts([text('缺失行书')],['Arial']).map(f=>f.family),['Zhi Mang Xing']);
});

test('并发页面只补齐所需一款，重建保留原生文字，后续不重复安装',async()=>{
  const f=fixture(),p={},signal=new AbortController().signal;
  const installer=(env,options)=>installOpenFonts(env,{...f.options,...options,catalog:options.catalog.map(font=>f.catalog.find(f=>f.id===font.id))});
  const elements=[{key:'title',type:'text',fontFace:'Ma Shan Zheng',text:'山川'}],options={inventory:f.options.inventory,installer};
  const results=await Promise.all([prepareElementFonts(p,f.env,elements,signal,options),prepareElementFonts(p,f.env,elements,signal,options)]);
  assert.deepEqual(f.counts(),{requests:2,installs:1});assert.equal(p.openFontSupport.mode,'automatic');assert.equal(p.openFontSupport.fonts.length,1);assert.ok(results.every(r=>r.elements[0].type==='text'&&r.elements[0].text==='山川'));
});

test('失败仅尝试一次并回退，新任务可重试；取消不吞掉',async()=>{
  const p={},env={data:'work/mock-font-cache',root:'.'},elements=[{key:'t',type:'text',fontFace:'Ma Shan Zheng'}];let attempts=0;
  const options={inventory:async()=>['Microsoft YaHei'],installer:async(_env,{catalog})=>{attempts++;return {fonts:catalog.map(f=>({...f,status:'failed',error:'offline'})),status:'partial'};}};
  const signal=new AbortController().signal;
  const result=await prepareElementFonts(p,env,elements,signal,options);assert.equal(result.elements[0].fontFace,'Microsoft YaHei');
  await prepareElementFonts(p,env,elements,signal,options);assert.equal(attempts,1);
  await prepareElementFonts(p,env,elements,new AbortController().signal,options);assert.equal(attempts,2);
  const controller=new AbortController();controller.abort();await assert.rejects(prepareElementFonts(p,env,elements,controller.signal,options),/abort/i);
});

test('七款字体包含四种书法与三种艺术方向，全部别名映射到真实字体族',()=>{
  assert.equal(openFontCatalog.length,7);assert.equal(openFontCatalog.filter(f=>f.category==='calligraphy').length,4);assert.equal(openFontCatalog.filter(f=>f.category==='artistic').length,3);
  for(const font of openFontCatalog)for(const alias of font.aliases){assert.equal(visualTextStyle({key:'t',fontFace:alias,size:50,bold:false},'title').fontFace,font.family);assert.equal(resolveNativeFonts([{key:'t',type:'text',fontFace:alias}],[font.family]).elements[0].fontFace,font.family);}
  const fonts=openFontCatalog.map(f=>f.family),context=nativeFontContext(fonts);for(const family of fonts)assert.ok(context.includes(family));assert.match(context,/草书仅在已批准设计需要/);
  const examples=[['缺失行书','Zhi Mang Xing'],['缺失草书','Liu Jian Mao Cao'],['缺失手写书法','Long Cang'],['缺失黄油艺术字','ZCOOL QingKe HuangYou'],['缺失装饰宋体艺术字','ZCOOL XiaoWei']];
  for(const [requested,used]of examples)assert.equal(resolveNativeFonts([{key:'t',type:'text',fontFace:requested,fontCategory:requested.includes('艺术')?'artistic':'calligraphy'}],fonts).elements[0].fontFace,used);
});

test('底层安装器支持完整目录，重复调用只补缺失字体',async()=>{
  const f=fixture(),template=f.catalog[0],catalog=openFontCatalog.map(font=>({...font,bytes:template.bytes,sha256:template.sha256,licenseHash:template.licenseHash}));
  const first=await installOpenFonts(f.env,{...f.options,catalog});assert.equal(first.fonts.length,7);assert.equal(first.status,'done');assert.deepEqual(f.counts(),{requests:14,installs:7});
  const again=await installOpenFonts(f.env,{...f.options,catalog});assert.ok(again.fonts.every(font=>font.status==='already_installed'));assert.deepEqual(f.counts(),{requests:14,installs:7});
  const script=fs.readFileSync('tools/install_open_font.ps1');assert.ok([...script].every(b=>b<128));assert.doesNotMatch(script.toString(),/Get-FileHash/);assert.match(script.toString(),/Security\.Cryptography\.SHA256/);
});
