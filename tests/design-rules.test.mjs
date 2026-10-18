import test from 'node:test';
import assert from 'node:assert/strict';
import {designCheckKeys,validateDesignChecks,designAcceptance,designRulesFor,navigationTexts,pageNeedsImage} from '../lib/design-rules.mjs';
import {validateSlides} from '../lib/scene.mjs';
import {pageDesignStamp,pageDesignInputCheck,pageDesignPrompt} from '../lib/page-design.mjs';
import {canonicalTexts,validateAudit} from '../lib/visual-model.mjs';
const p=()=>({brief:{title:'论文答辩',progress:true,toc:true},materials:[],slides:[{kind:'cover',title:'封面',body:[],sources:[]},{kind:'content',title:'目录',body:[],sources:[]},{kind:'section',title:'研究方法',body:[],sources:[]},{kind:'content',title:'方法验证',body:[],sources:[]}]});
const checks=(special=true)=>validateDesignChecks({...Object.fromEntries(designCheckKeys.map(k=>[k,true])),special_split:special,split_kind:special?'sector':'regular',reason:'扇形说明方法构成，原图与标题独立。'});
test('封面标题页和目录默认无配图，验收不因无图否决；手动图片仍保留',()=>{
  const project=p();assert.equal(pageNeedsImage(project,0),false);assert.equal(pageNeedsImage(project,1),false);assert.equal(pageNeedsImage(project,3),true);
  assert.match(designRulesFor(project,0),/默认无配图，不生成图片或要求补图/);
  const pages=project.slides.map(()=>({designChecks:checks()}));pages[0].designChecks.related_visual=false;pages[1].designChecks.related_visual=false;
  assert.equal(designAcceptance(project,pages).passed,true);
  project.slides[0].imageId='manual-image';assert.equal(pageNeedsImage(project,0),true);assert.equal(designAcceptance(project,pages).passed,false);
  project.slides[3].kind='toc';project.brief.toc=false;assert.equal(pageNeedsImage(project,3),false);assert.deepEqual(navigationTexts(project,3),[]);
  assert.equal(validateSlides([{title:'目录',kind:'toc',body:[],sources:[]}])[0].kind,'toc');
});
test('特殊分块仅作为创作要求，普通布局不阻止验收，质量检查仍必需',()=>{
  const project=p();assert.throws(()=>validateDesignChecks({passed:true}),/逐项/);
  const regular=validateDesignChecks({...checks(),special_split:'invalid legacy value',split_kind:'unknown'});
  assert.equal(regular.special_split,undefined);assert.equal(regular.split_kind,undefined);assert.equal(regular.warnings,undefined);
  const pages=project.slides.map(()=>({designChecks:regular}));
  assert.equal(designAcceptance(project,pages).passed,true);assert.equal(designAcceptance(project,pages).specialPages,undefined);
  pages[3]={designChecks:{...regular,image_integrity:false}};assert.equal(designAcceptance(project,pages).passed,false);
  pages[3]={designChecks:{...regular,policyVersion:'old'}};assert.equal(designAcceptance(project,pages).passed,false);
  assert.match(designRulesFor(project,0),/特殊分块仅为创作要求/);
});
test('移除分块分类不能掩盖真实质量问题或缺失的看图结论',()=>{
  const regular=validateDesignChecks({...checks(),split_kind:'regular',readability:false});
  assert.equal(regular.readability,false);assert.equal(regular.special_split,undefined);
  assert.throws(()=>validateDesignChecks({...checks(),readability:undefined}),/逐项/);
  assert.match(designRulesFor(p(),0),/不分类、不统计达标数量/);
});
test('设计阶段先评估特殊分块适配性并积极采用，审核不恢复分块门槛',()=>{
  const project=p(),prompt=pageDesignPrompt(project,3);
  assert.match(prompt,/先判断本页是流程、对比、层级、并列还是中心与支撑关系/);
  assert.match(prompt,/适合时必须采用/);assert.match(prompt,/文字体量、图片比例与阅读顺序/);
  assert.match(prompt,/layoutIntent 用1–2句说明本页关系、选择的形态及表达作用/);
  assert.match(prompt,/采用常规布局时简述为何更合适/);assert.match(prompt,/落实到对应节点位置和 carrier/);
  assert.match(prompt,/不能把并列画成层级或因果/);assert.match(prompt,/斜切可用于对照/);assert.match(prompt,/弧线可用于历程串联/);
  assert.doesNotMatch(prompt,/严格过半/);assert.match(prompt,/不设特殊分块页数配额/);
  const review=designRulesFor(project,3,'review');
  assert.doesNotMatch(review,/特殊分块选择：|适合时积极优先采用|严格过半|floor\(N\/2\)/);
  assert.match(review,/不因常规布局或特殊分块不足而判 failed/);
});
test('图注缺口在设计稿阶段提示，原图底色不归入新增装饰；本步未通过不能批准',()=>{
  const project=p();project.slides[0].elements=[{id:'title',type:'text',role:'title',label:'标题',text:'封面',parentId:null},{id:'pic',type:'image',label:'原件',materialId:'m',parentId:'title'}];
  assert.match(pageDesignInputCheck(project,0).warnings[0],/缺少图注/);
  project.slides[0].elements.push({id:'caption',type:'text',role:'caption',label:'图注',text:'图1 原始策略图',parentId:'pic'});assert.deepEqual(pageDesignInputCheck(project,0).warnings,[]);
  assert.match(designRulesFor(project,0,'image'),/不是新增装饰/);
  const pages=project.slides.map(()=>({designChecks:checks(),previewReview:{status:'passed',issues:[]}}));assert.equal(designAcceptance(project,pages).passed,true);
  pages[0].previewReview={status:'needs_revision',issues:['文字遮挡']};assert.equal(designAcceptance(project,pages).passed,false);assert.match(designAcceptance(project,pages).issues.join('；'),/文字遮挡/);
});
test('页顶导航固定章节段，封面和目录省略，章节名变化使依赖设计稿失效',()=>{
  const project=p();assert.deepEqual(navigationTexts(project,0),[]);assert.deepEqual(navigationTexts(project,1),[]);
  assert.equal(navigationTexts(project,3)[0].text,'研究方法');assert.equal(navigationTexts(project,3)[0].current,true);
  const stamp=pageDesignStamp(project,3);project.slides[2].title='实验方法';assert.notEqual(pageDesignStamp(project,3),stamp);
  const s=project.slides[3],nodes=canonicalTexts(s,project,3),audit=nodes.map((n,i)=>({key:'text-'+i,type:'text',nodeId:n.nodeId,text:n.text,x:50,y:20,w:600,h:60,size:25,color:'272727',bold:true}));
  assert.equal(validateAudit(audit,s,[],project,3).length,6);
  assert.throws(()=>validateAudit(audit.filter(e=>e.nodeId!=='navigation-section-1'),s,[],project,3),/遗漏/);
  audit[1].y=800;assert.throws(()=>validateAudit(audit,s,[],project,3),/顶部/);
});
test('学术填充与字号建议依场景区分，生图不发送具体字号',()=>{
  const project=p();assert.match(designRulesFor(project,2),/文本框内尽量不要有渐变/);
  assert.match(designRulesFor(project,2),/约18pt/);assert.doesNotMatch(designRulesFor(project,2,'image'),/约18pt/);
  project.brief.purpose='创新创业路演';assert.doesNotMatch(designRulesFor(project,2),/文本框内尽量不要有渐变/);
});
test('设计依赖不受来源对象属性顺序影响，真实内容变化仍会失效',()=>{
  const project=p();project.slides[0].sourceLinks=[{materialId:'m',target:'title',quote:'封面',note:'来源',id:'link'}];
  const stamp=pageDesignStamp(project,0);project.slides[0].sourceLinks=[{id:'link',note:'来源',quote:'封面',target:'title',materialId:'m'}];
  assert.equal(pageDesignStamp(project,0),stamp);project.slides[0].sourceLinks[0].note='另一个解释';assert.notEqual(pageDesignStamp(project,0),stamp);
});
