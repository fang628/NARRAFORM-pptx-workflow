const designChecks={related_visual:true,semantic_layout:true,independent_text:true,title_hierarchy:true,readability:true,restrained_decoration:true,image_integrity:true,top_progress:true,academic_fill:true,special_split:true,split_kind:'custom',reason:'合成设计规范响应，只验证闸门协议，不代表实际审美判断'};
import {Resvg} from '@resvg/resvg-js';
import crypto from 'node:crypto';
import {splitHeadingNumber} from '../lib/rebuild-text-parts.mjs';
export async function fixtureRequest(req){
  const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks);
  if(!req.headers['content-type']?.startsWith('multipart/'))return JSON.parse(bytes.toString('utf8'));
  const form=await new Request('http://127.0.0.1',{method:'POST',headers:{'content-type':req.headers['content-type']},body:bytes}).formData(),result={referenceImages:[]};
  for(const [key,value] of form){if(typeof value==='string')result[key]=key==='n'?Number(value):value;else result.referenceImages.push({field:key,size:value.size,sha256:crypto.createHash('sha256').update(Buffer.from(await value.arrayBuffer())).digest('hex')});}return result;
}
export const fixtureDirections=()=>['a','b','c'].map((id,i)=>({id,referenceStyleId:['A','B','D'][i],name:['浅蓝科研','深蓝技术','靛蓝编辑'][i],description:'依据材料的研究主题选择，构图与层级有不同策略',style:['明亮浅蓝，证据优先','深蓝底，放射关系','靛蓝浅底，杂志式编排'][i],coreColor:['#E4F4FB','#01126B','#EEF4FA'][i],typography:'标题深色无衬线、正文深蓝，小标题清晰，非机械艺术字',frames:'正文无框，短标签平整浅色填充、细线描边',decoration:'少量主题线条避开文字区',layoutLanguage:['左图右文，中心支撑','放射结构与独立证据','不对称分区与层级'][i],heroSubject:'右侧具象微观分子实体',tocSubject:'同一分子实体的具象近景',textArea:'左侧标题与目录连续留白，正文区域不放密集细节'}));
export const fixtureCustomDirections=()=>fixtureDirections().map((d,i)=>({...d,referenceStyleId:null,styleSelection:{matchingPresetIds:[],reason:'合成案例预设均不适用'},name:['明亮编辑','深色工业','极简网格'][i],description:'合成模型只验证执行链路',style:['浅灰与黄，左文右图，独立渐变','暗色和黄色，非对称分块','纸白和灰，精细线条'][i]}));
export function fixturePlannedDirections(prompt,{custom=false}={}){
  const sources=JSON.parse((prompt.split('主题灵感材料：')[1]||prompt.split('主体来源材料：')[1])?.split('\n')[0]||'[]');
  return (custom?fixtureCustomDirections():fixtureDirections()).map(d=>({...d,styleSelection:custom?d.styleSelection:{matchingPresetIds:['A','B','D'],reason:'合成测试：科研题材适用这些预设'},subjectSources:Object.fromEntries(['heroSubject','tocSubject','contentSubject'].map(k=>[k,{materialId:sources[0]?.id,evidenceId:sources[0]?.evidence?.[0]?.id,element:'分子实体',scope:'whole-deck',scopeReason:'该对象是全篇研究的核心实体，各章节围绕其研究展开'}]))}));
}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
export function fixtureReply(b,options={}){
  const user=b.messages?.at(-1)?.content,prompt=typeof user==='string'?user:user?.[0]?.text||'';
  if(prompt.startsWith('修正当前页的元素审计JSON')){
    const texts=JSON.parse(prompt.split('准确文字（唯一来源，每个nodeId恰好一次）：')[1].split('\n登记原图')[0]),images=JSON.parse(prompt.split('登记原图（身份与位置原样保留）：')[1].split('\n上次审计结果：')[0]);
    return fixtureReply({...b,messages:[{role:'user',content:[{type:'text',text:`自由元素审计：\n准确文字：${JSON.stringify(texts)}\n登记原图计划：${JSON.stringify(images)}\n设计稿：合成测试\n固定页面背景：测试底图`}]}]},options);
  }
  if(b.prompt){
    if(b.prompt.includes("对随附局部装饰"))return {data:[{b64_json:new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><circle cx="960" cy="540" r="250" fill="#fff238"/></svg>').render().asPng().toString("base64")}]};
    const canonical=b.prompt.includes('**内容要求**')?[...b.prompt.split('- **排版要求**')[0].matchAll(/^\s+- (标题|副标题|正文|注释|小标题|页顶导航)：(.+)$/gm)].map(m=>({role:m[1],text:m[2]})):[];
    const width=options.badRatio?1500:1600;
    const png=new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="900"><defs><linearGradient id="g"><stop stop-color="#eeeece"/><stop offset="1" stop-color="#dbdfcc"/></linearGradient></defs><rect width="1600" height="900" fill="#e9ece1"/><rect x="1100" y="0" width="500" height="900" fill="url(#g)"/><circle cx="1450" cy="730" r="55" fill="#fff238"/>${canonical.map((n,i)=>`<text x="90" y="${n.role==='页顶导航'?35:140+i*92}" font-family="Microsoft YaHei" font-size="${i?28:40}" fill="#272727">${esc(n.text)}</text>`).join('')}</svg>`,{font:{loadSystemFonts:true}}).render().asPng();
    return {data:[{b64_json:png.toString('base64')}]};
  }
  let result;
  if(prompt.startsWith('生图提示词发送前检查：'))result={passed:true,issues:[],correctedPrompt:null};
  else if(prompt.startsWith('提取页顶横列样式：'))result={referenceIndex:JSON.parse(prompt.split('可选页索引：')[1])[0],box:[0,0,1,.18],appearance:{accent:'315678',track:'DDEEFF',completedFill:'AACCDD',ink:'272727',muted:'334455',indicatorInk:'FFFFFF',border:'8899AA',completedBorder:'557788',activeBorder:'112233',shadow:{color:'000000',opacity:.12,blur:2,offset:1,angle:90}},evidence:'合成测试：只验证选定单张预览与取色协议'};
  else if(prompt.includes('按照 pptx-workflow 1.3')){const nodes=JSON.parse(prompt.split('已有节点：')[1].split('\n使用的材料：')[0]);result={purpose:'合成页面验证',conclusion:'保持事实和层级',logic:'承接前页进入下一步',layoutIntent:'左文右图，装饰独立重建',style:'浅灰底深字、亮黄色强调、独立渐变与圆形装饰',readingOrder:nodes.map(n=>n.id),nodes:nodes.map(n=>({id:n.id,position:n.type==='image'?'右上':'左侧',relativeSize:'中等',alignment:'左对齐',carrier:'独立原生对象',relation:n.parentId?'附属'+n.parentId:'并列'})),differences:'保留每页准确内容',missingMaterials:[]};}
  else if(prompt.includes('识别与理解单份材料'))result={category:'研究材料',summary:'分子修饰研究材料',keyPoints:['分子修饰'],facts:[],suggestedUse:'主题与配图',questions:[]};
  else if(prompt.startsWith('汇总材料理解')){const readings=JSON.parse(prompt.split('材料理解：')[1]);result={summary:'分子修饰与递送研究',outline:[{title:'研究目标',sourceIds:readings.map(r=>r.id)}],questions:[]};}
  else if(prompt.startsWith('三方向底图规划：'))result={directions:fixturePlannedDirections(prompt,{custom:options.customDirections})};
  else if(prompt.startsWith('检查三方向底图：'))result={passed:!options.backgroundIssue,issues:options.backgroundIssue?['合成检查：主体大面积遮挡预留阅读区']:[],notes:'合成模型已收到当前底图与同方向其他底图，不代表真实审美评估'};
  else if(prompt.startsWith('按自然语言修改无字主题底图提示词'))result={prompt:prompt.split('原提示词：')[1]+'\n减少左侧细线，保留主体和底色。'};
  else if(prompt.startsWith('concepts:'))result={concepts:['a','b','c'].map((id,i)=>({...fixtureDirections()[i],id,referenceStyleId:null,styleSelection:{matchingPresetIds:[],reason:'合成案例预设均不适用'},name:['明亮编辑','深色工业','极简网格'][i],description:'合成模型只验证执行链路',style:['浅灰与黄，左文右图，独立渐变','暗色和黄色，非对称分块','纸白和灰，精细线条'][i]}))};
  else if(prompt.startsWith('图片计划：')||prompt.startsWith('定位图片预留区：')){const images=JSON.parse(prompt.split('登记图片：')[1].split('\n视觉方向：')[0]);result={...(prompt.startsWith('定位图片预留区：')?{placeholderCount:images.length,countEvidence:'合成看图响应：逐一清点预留区'}:{}),images:images.map((n,i)=>{const aspect=n.aspect||350/190,h=Math.min(190,350/aspect);return {...n,x:1130,y:120+i*210,w:h*aspect,h};})};}
  else if(prompt.startsWith('贴回原图后的几何修正：')){const images=JSON.parse(prompt.split('当前原图：')[1].split('\n本轮图片几何问题：')[0]);result={images:images.map(n=>({...n,x:n.x-10,w:n.w-10,background:'不应接受该字段'}))};}
  else if(prompt.startsWith('检查生图整页成品：')){const badDecoration=options.badDecoration&&prompt.includes('风格：纸白和灰');result={imageGeometryIssues:options.badPageReview?['原图遮挡文字，需要移动缩小']:[],designChecks:{...designChecks,...(options.conflictingSplit?{split_kind:'regular'}:{}),...(badDecoration?{restrained_decoration:false,reason:'合成检查：新增装饰过多，需在当前方案步骤调整'}:{})},passed:!options.badPageReview,issues:options.badPageReview?['合成检查：文字区域被遮挡']:[],notes:'合成模型响应，已接收实际PNG，供管线测试。'};}
  else if(prompt.startsWith('自由元素审计：')){
    const texts=JSON.parse(prompt.split('准确文字：')[1].split('\n登记原图计划：')[0]),images=JSON.parse(prompt.split('登记原图计划：')[1].split('\n设计稿：')[0]);
    const navigation=texts.filter(n=>n.role==='navigation'),navWidth=1420/Math.max(1,navigation.length);
    result={elements:[{key:'background',type:'rect',x:0,y:0,w:1600,h:900,fill:'e9ece1'},{key:'gradient',type:'svg',x:1100,y:0,w:500,h:900,description:'右侧独立渐变',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 900"><defs><linearGradient id="g"><stop stop-color="#eeeece"/><stop offset="1" stop-color="#dbdfcc"/></linearGradient></defs><rect width="500" height="900" fill="url(#g)"/></svg>'},{key:'dot',type:'ellipse',x:1395,y:675,w:110,h:110,fill:'fff238'},...texts.map((n,i)=>({key:'text-'+i,type:'text',nodeId:n.nodeId,text:n.text,x:n.role==='navigation'?86+navigation.findIndex(t=>t.nodeId===n.nodeId)*navWidth:90,y:n.role==='navigation'?15:100+i*92,w:n.role==='navigation'?navWidth-12:980,h:n.role==='navigation'?55:75,size:n.role==='navigation'?20:i?28:40,color:'272727',bold:i===0,align:'left'})),...images.map((n,i)=>({...n,key:'image-'+i,type:'image'}))],notes:'合成审计新增独立渐变 SVG 和圆形，与原生文字和登记原件分别保存。'};
    result.elements=result.elements.flatMap(e=>{const n=texts.find(n=>n.nodeId===e.nodeId),split=n?.role==='heading'?splitHeadingNumber(n.text):null;return e.type==='text'&&split?[{...e,key:e.key+'-number',part:'number',text:split.number,w:80},{...e,key:e.key+'-label',part:'label',text:split.label,x:e.x+90,w:e.w-90}]:[e];});
    if(prompt.includes('固定页面背景：')){result.elements=result.elements.filter(e=>!['background','gradient','dot'].includes(e.key));result.elements.unshift({key:'content-icon',type:'svg',x:1040,y:700,w:60,h:60,description:'新增的独立内容图标',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><path d="M10 30h40M30 10v40" fill="none" stroke="#556677" stroke-width="2"/></svg>'});}
    if(options.badAudit)result.elements=result.elements.filter(e=>e.key!=='text-0');
    if(options.extraAssets)result.elements.push({key:"extra-icon",type:"svg",x:1400,y:800,w:100,h:70,svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 70"><path d="M5 5L95 5L80 65L20 65Z" fill="#fff238"/></svg>',description:"SVG独立图标"},{key:"cutout",type:"cutout",x:1200,y:700,w:150,h:120,sourceBox:{x:1400,y:800,w:100,h:70},prompt:"保留局部非事实装饰的纹理和轮廓，移除背景",nonFactual:true,description:"图生图抠图的独立装饰"});
  }else if(prompt.startsWith('渲染对照验收：'))result={designChecks,checks:{visual:!options.badReview,content:true,photos:true,preview_match:true},issues:options.badReview?['合成验收故意判定装饰遗漏']:[],deviations:['原生文字替换模型字形'],notes:'已检查三张实际图像输入；这是合成验收响应，用于验证下载闸门，不代表真实模型质量。'};
  else if(prompt.startsWith('按用户要求修改以下整页生图提示词'))result={prompt:prompt.split('原提示词：')[1]+'\n增加留白并精简装饰。'};
  else return null;
  return {choices:[{message:{content:JSON.stringify(result)}}]};
}
