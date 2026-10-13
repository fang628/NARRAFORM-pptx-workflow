import test from 'node:test';
import assert from 'node:assert/strict';
import {slideImagePrompt,effectiveSlideImagePrompt} from '../lib/slide-image-prompts.mjs';
import {designRulesFor} from '../lib/design-rules.mjs';
import {themeAssetPrompt} from '../lib/theme-assets.mjs';
import {correctionPrompt} from '../lib/visual-repair.mjs';
import {imageStyle} from '../lib/image-prompts.mjs';
import {nestedContentList} from '../lib/prompt-structure.mjs';
import {initialElements,orderedElements} from '../lib/elements.mjs';

function fixture(){
  const elements=[
    {id:'S01-TITLE',type:'text',role:'title',text:'两种模型的评价结果',label:'标题',parentId:null},
    {id:'S01-SUB',type:'text',role:'subtitle',text:'PEG-TP5，5 μmol/L',label:'副标题',parentId:'S01-TITLE'},
    {id:'S01-GROUP',type:'group',label:'巨噬细胞模型',parentId:'S01-TITLE'},
    {id:'S01-BODY',type:'text',role:'body',text:'LPS 刺激 24 h，保留比较口径与限制。',label:'实验条件',parentId:'S01-GROUP'},
    {id:'S01-IMAGE',type:'image',label:'TNF-α 检测结果',materialId:'GEN-001',parentId:'S01-GROUP'},
    {id:'S01-CAPTION',type:'text',role:'caption',text:'原始检测与统计结果。',label:'图注',parentId:'S01-IMAGE'},
  ];
  const slide={kind:'content',title:elements[0].text,body:[],sources:[],elements};
  const p={brief:{title:'学术答辩',toc:false,progress:true},slides:[{kind:'section',title:'结果与讨论',body:[],sources:[]},slide],materials:[{id:'GEN-001',name:'检测图'}],pageDesigns:{1:{plan:{layoutIntent:'左右对照，证据紧邻所属观点',logic:'两种模型并列，不宣称因果',nodes:elements.map(n=>({id:n.id,position:'左侧',relation:n.parentId?'从属于 '+n.parentId:'统领本页'}))}}}};
  const d={id:'a',styleSummary:'冷白蓝绿，医学期刊气质',style:'不应使用的重复长风格',coreColor:'#F5F8FC',typography:'无衬线，深蓝标题与正文',frames:'正文无框，必要浅色承载',decoration:'少量主题曲线',layoutLanguage:'不对称对照',heroSubject:'抽象肽链',tocSubject:'蛋白口袋',textArea:'左侧标题与导航留白'};
  return {p,d,images:[{nodeId:'S01-IMAGE',id:'GEN-001',x:1000,y:180,w:465,h:300,aspect:1.55}]};
}

test('整页提示词八项自足，原文与多层图片归属保留，工程信息不进入生图',()=>{
  const {p,d,images}=fixture(),prompt=slideImagePrompt(p,1,d,images,'concept');
  assert.equal([...prompt.matchAll(/^- \*\*/gm)].length,8);
  for(const n of p.slides[1].elements.filter(n=>n.type==='text'))assert.ok(prompt.includes(n.text));
  assert.match(prompt,/    - 小标题：“巨噬细胞模型”/);
  assert.match(prompt,/      - 图片“TNF-α 检测结果”/);
  assert.match(prompt,/        - 注释：原始检测与统计结果。/);
  assert.match(prompt,/1\.55:1/);assert.match(prompt,/展示前本地贴回原件/);
  assert.match(prompt,/当前“结果与讨论”/);assert.match(prompt,/页顶且仅一条粗分段/);
  assert.match(prompt,/文本框内尽量不要有渐变/);assert.match(prompt,/文本框底色和背景主色之间要有色差/);
  assert.match(prompt,/\*\*简约要求\*\*/);assert.match(prompt,/\*\*紧密排版要求\*\*/);
  const styleSection=prompt.split('- **风格要求**')[1].split('- **进度条要求**')[0];
  assert.ok(styleSection.length<300,'普通页面的风格和两个子项应控制在约300字内');assert.doesNotMatch(styleSection,/不对称对照|若其旧配色|组合和局部轮廓/);
  assert.doesNotMatch(prompt,/\*\*原图保真要求\*\*/);assert.match(prompt,/实际排版要有创意，保留合理的组合与局部构图发挥空间。/);
  assert.doesNotMatch(prompt,/设计规范版本|restrained_decoration|floor\(N\/2\)|S01-|GEN-001|不应使用的重复长风格/);
  const layoutSection=prompt.split('- **排版要求**')[1].split('- **图片占位框比例**')[0];
  assert.match(layoutSection,/适配内容时积极采用有表达作用的特殊分块/);
  assert.match(layoutSection,/依已确认分块构建/);assert.match(layoutSection,/不默认重复斜切或弧线/);
  assert.doesNotMatch(styleSection,/扇形、同心、波浪/,'分块要求不重复堆进风格项');
  assert.ok(prompt.length<1700,'短文案页面无需附加整段工作流');
});

test('内容与排版用相同的多层列表保留从属、并列及图注，导航不混入正文',()=>{
  const {p,d,images}=fixture(),s=p.slides[1];
  s.elements.push({id:'SECOND-GROUP',type:'group',label:'T 细胞模型',parentId:'S01-TITLE'},
    {id:'SECOND-BODY',type:'text',role:'body',label:'功能指标',text:'比较细胞活性。',parentId:'SECOND-GROUP'},
    {id:'SECOND-DETAIL',type:'text',role:'body',label:'条件',text:'相同处理条件。',parentId:'SECOND-BODY'},
    {id:'PEER-BODY',type:'text',role:'body',label:'对照指标',text:'记录对照结果。',parentId:'SECOND-GROUP'});
  p.pageDesigns[1].plan.nodes.push(...s.elements.slice(-4).map(n=>({id:n.id,relation:'并列',position:'右侧'})));
  const prompt=slideImagePrompt(p,1,d,images),content=prompt.split('- **内容要求**')[1].split('- **排版要求**')[0];
  assert.match(content,/\n  - 标题：两种模型的评价结果\n    - 副标题：PEG-TP5，5 μmol\/L\n    - 小标题：巨噬细胞模型\n      - 正文：LPS/);
  assert.match(content,/\n      - 图片：TNF-α 检测结果\n        - 注释：原始检测与统计结果。/);
  assert.match(content,/\n    - 小标题：T 细胞模型\n      - 正文：比较细胞活性。\n        - 正文：相同处理条件。\n      - 正文：记录对照结果。/);
  assert.match(content,/同一父项下的同级正文为并列/);assert.match(content,/\n  - 页顶导航（独立于正文结构）：\n    - 页顶导航：结果与讨论/);
  const layout=prompt.split('- **排版要求**')[1].split('- **图片占位框比例**')[0];
  assert.match(layout,/\n    - 小标题：“T 细胞模型”/);assert.match(layout,/\n      - 正文：“功能指标”/);assert.match(layout,/\n        - 正文：“条件”；右侧。/);
  assert.doesNotMatch(layout,/条件”；右侧；并列/,'过期设计稿的并列措辞不能覆盖内容树从属');
  assert.doesNotMatch(prompt,/S01-|SECOND-|PEER-/);assert.equal([...prompt.matchAll(/^- \*\*/gm)].length,8);
  assert.equal(nestedContentList(orderedElements(initialElements(s))).includes('页顶导航'),false);
});

test('旧格式正文也嵌套在主标题下，不把正文提升为标题同级',()=>{
  const result=nestedContentList(orderedElements(initialElements({title:'汇报目标',subtitle:'问题与方法',body:['目标一','目标二']})));
  assert.equal(result,'  - 标题：汇报目标\n    - 副标题：问题与方法\n    - 正文：目标一\n    - 正文：目标二');
});

test('封面目录不补事实图片，学术限制依实际用途适用',()=>{
  const {p,d}=fixture();p.slides[1]={kind:'toc',title:'汇报内容',body:['研究背景','评价结果'],sources:[]};
  p.pageDesigns[1].plan.nodes=[];
  const toc=slideImagePrompt(p,1,d,[]);assert.match(toc,/比例要求\*\*：目录页/);assert.match(toc,/无进度条/);assert.match(toc,/本页无配图/);
  p.brief.title='创新创业路演';assert.doesNotMatch(slideImagePrompt(p,1,d,[]),/文本框内尽量不要有渐变/);
  const background=themeAssetPrompt(p,d,'hero-image');assert.match(background,/主体为视觉重心/);assert.match(background,/铺满预定视觉区/);assert.ok(background.includes(d.coreColor));assert.ok(background.includes(d.heroSubject));assert.ok(background.includes(d.textArea));assert.doesNotMatch(background,/无衬线|正文无框|不应使用的重复长风格/);
});

test('自然语言修改与返工不会累积规范，旧版尾部用户修改保留',()=>{
  const {p,d,images}=fixture(),base=slideImagePrompt(p,1,d,images),legacy=base+'\n'+designRulesFor(p,1,'image')+'\n保留这条用户修改：蓝色细线。';
  const first=effectiveSlideImagePrompt(p,1,d,images,'full',legacy);
  assert.match(first,/保留这条用户修改：蓝色细线/);assert.doesNotMatch(first,/设计规范版本：/);
  const second=effectiveSlideImagePrompt(p,1,d,images,'full',first+'\n主标题上移，保留正文。');
  assert.ok(!second.includes('【本次生成边界】'),'完整八项任务不再附加重复边界');assert.match(second,/主标题上移/);
  assert.equal(effectiveSlideImagePrompt(p,1,d,images,'full',second),second);
  const repair=correctionPrompt(second,['设计规范未通过：readability；文字被装饰遮挡','设计规范未通过：restrained_decoration；文字被装饰遮挡']);
  assert.equal(repair.split('文字被装饰遮挡').length,2);assert.doesNotMatch(repair,/restrained_decoration|readability/);
  assert.match(repair,/不得编造图注/);
  const nextRepair=correctionPrompt(repair+'\n保留这条手工说明。',['图注靠近图片']);
  assert.equal(nextRepair.split('【本步自动视觉修正】').length,2);assert.doesNotMatch(nextRepair,/文字被装饰遮挡/);assert.doesNotMatch(nextRepair,/保留这条手工说明|\*\*内容要求\*\*/,'修正只发当次调整，不叠加原设计或旧稿');
});

test('长风格压缩保留配色、文字角色、特殊框形及必要渐变，不改变登记定义',()=>{
  const {p,d,images}=fixture();Object.assign(d,{name:'冷白医学',styleSummary:'核心底色 #F5F8FC；主色 #14344D 用于标题；辅助色 #A9CFD7；强调色 #087F8C。'+('共同规范不得反复追加。'.repeat(30)),typography:'Microsoft YaHei，标题深蓝 #14344D，正文墨灰 #334455；'+('通用排印说明。'.repeat(30)),frames:'正文无框，分标题平整浅色填充；'+('通用承载规范。'.repeat(30))+'弧形边界裁切，连接区使用蓝绿渐变',decoration:'少量分子曲线；'+('通用装饰说明。'.repeat(30))});
  const snapshot=structuredClone(d),style=imageStyle(d),prompt=slideImagePrompt(p,1,d,images);
  for(const value of ['#F5F8FC','#14344D','#A9CFD7','#087F8C','#334455','Microsoft YaHei','正文无框','弧形边界裁切','蓝绿渐变'])assert.ok(style.includes(value),value);
  assert.ok(style.length<450);assert.ok(prompt.length<1700);assert.equal([...prompt.matchAll(/^- \*\*/gm)].length,8);assert.deepEqual(d,snapshot);
});

test('八项修改稿缺少边界时补到原分项，短意见不追加整套风格',()=>{
  const {p,d,images}=fixture(),base=slideImagePrompt(p,1,d,images).replaceAll(d.coreColor,'#EEEEEE').replace('文本框底色和背景主色之间要有色差。','');
  const next=effectiveSlideImagePrompt(p,1,d,images,'full',base);
  assert.equal([...next.matchAll(/^- \*\*/gm)].length,8);assert.ok(next.includes(d.coreColor));assert.match(next,/文本框底色和背景主色之间要有色差/);assert.doesNotMatch(next,/【本次生成边界】/);
  assert.equal(effectiveSlideImagePrompt(p,1,d,images,'full',next),next);
  const short=effectiveSlideImagePrompt(p,1,d,images,'full','主图靠右，副标题上移。');assert.match(short,/主图靠右/);assert.doesNotMatch(short,/少量主题曲线|正文无框/);assert.ok(short.length<350);
});

test('正文只在内容项出现一次；补充同义要求不会再叠加整套说明',()=>{
  const {p,d,images}=fixture(),prompt=effectiveSlideImagePrompt(p,1,d,images,'full',slideImagePrompt(p,1,d,images));
  for(const n of p.slides[1].elements.filter(n=>n.type==='text'))assert.equal(prompt.split(n.text).length,2,'准确文案只列一次：'+n.role);
  const draft=prompt.replace('文本框底色和背景主色之间要有色差。','文本框与页面背景保持足够对比。').replace('不重画事实内容','禁止重绘原图').replace('展示前本地贴回原件','展示前本地回填原图');
  assert.equal(effectiveSlideImagePrompt(p,1,d,images,'full',draft),draft,'已有同义要求不再追加');
  assert.equal(effectiveSlideImagePrompt(p,1,d,images,'full',prompt),prompt);
});

test('旧九项改为八项，必要原图说明归入配图，特殊承载带入实际画图任务',()=>{
  const {p,d,images}=fixture();p.pageDesigns[1].plan.nodes.find(n=>n.id==='S01-BODY').carrier='弧形边界裁切的文本框，正文平整填充 #F0F3F8';
  const current=slideImagePrompt(p,1,d,images),legacy=current.replace('不重画事实内容','待本地处理')+'\n- **原图保真要求**：事实原件不重画、不拉伸。\n用户补充：左侧更紧凑。';
  const revised=effectiveSlideImagePrompt(p,1,d,images,'full',legacy);
  assert.equal([...revised.matchAll(/^- \*\*/gm)].length,8);assert.doesNotMatch(revised,/\*\*原图保真要求\*\*/);
  assert.match(revised,/用户补充：左侧更紧凑/);
  const pictureSection=revised.split('- **图片占位框比例**')[1].split('- **风格要求**')[0];assert.match(pictureSection,/不重画事实内容/);assert.match(pictureSection,/平坦无字占位块/);
  assert.match(current.split('- **排版要求**')[1].split('- **图片占位框比例**')[0],/正文：.*弧形边界裁切的文本框/);assert.doesNotMatch(current.split('- **风格要求**')[1],/本页承载/);assert.doesNotMatch(current,/#F0F3F8/,'单页旧配色不覆盖所选视觉方向');
});
