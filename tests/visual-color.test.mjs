import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {Resvg} from '@resvg/resvg-js';
import {visualColor,visualColorRule} from '../lib/visual-color.mjs';
import {validateAudit,nativeSVG,digest} from '../lib/visual-model.mjs';
import {buildVisualDeck} from '../lib/visual-build.mjs';
import {themeAssetsStamp} from '../lib/theme-assets.mjs';
import {slideBackground} from '../lib/slide-background.mjs';

test('模型常见颜色写法归一为准确RGB，保留透明度，不猜测无效颜色',()=>{
  for(const [value,color] of [['#ffffff','FFFFFF'],['  #AbC  ','AABBCC'],['aabbcc','AABBCC'],['rgb(12, 34, 56)','0C2238'],['rgb(100% 50% 0%)','FF8000'],['White','FFFFFF'],['lightgray','D3D3D3']])assert.deepEqual(visualColor(value),{color,alpha:1});
  assert.deepEqual(visualColor('rgba(12, 34, 56, 0.4)'),{color:'0C2238',alpha:.4});assert.deepEqual(visualColor('rgb(12 34 56 / 40%)'),{color:'0C2238',alpha:.4});assert.deepEqual(visualColor('#fff8'),{color:'FFFFFF',alpha:136/255});assert.deepEqual(visualColor('#12345680'),{color:'123456',alpha:128/255});assert.deepEqual(visualColor('transparent'),{color:'000000',alpha:0});assert.equal(visualColor(null,'272727').color,'272727');
  for(const v of ['rgb(256,0,0)','rgba(1,2,3,1.5)','rgb(1 2)','rgb(1,2,3,4,5)','linear-gradient(red,blue)','var(--accent)',{r:1},123,'#zzzzzz',''])assert.throws(()=>visualColor(v,null,{key:'subtitle-2',field:'color'}),e=>e.code==='INVALID_VISUAL_COLOR'&&e.message.includes('subtitle-2')&&e.message.includes('color'));
  assert.match(visualColorRule,/SVG内部按标准CSS颜色/);
});

test('拆解兼容CSS颜色，透明填充与线条分别处理，准确文案检查继续执行',()=>{
  const s={title:'准确标题',body:[],sources:[]},text={key:'title',type:'text',nodeId:'title',text:s.title,x:50,y:30,w:800,h:80,size:40,color:'rgba(39,39,39,0.5)',opacity:.5,bold:true};
  const shape={key:'panel',type:'rect',x:50,y:200,w:400,h:200,fill:'rgba(255,255,255,0.4)',color:'#fff',opacity:.5},line={key:'line',type:'line',x:50,y:500,w:400,h:1,fill:'none',color:'#FF0000',strokeWidth:2};
  const out=validateAudit([text,shape,line],s,[]);assert.equal(out[0].color,'272727');assert.equal(out[0].opacity,.25);assert.equal(out[1].opacity,.5);assert.equal(out[1].fillOpacity,.4);assert.equal(out[2].opacity,1,'线条的无填充不能使描边消失');
  assert.equal(validateAudit([{...text,color:'#fff',opacity:null},{...shape,fill:'none'}],s,[])[1].fillOpacity,0);
  assert.throws(()=>validateAudit([{...text,text:'篡改标题'}],s,[]),/准确文字/);assert.throws(()=>validateAudit([text,{...shape,fill:'错误颜色'}],s,[]),/panel · fill：错误颜色/);
  const svg=nativeSVG(out,()=>''),plain=svg.replace('<text ','<text data-test="native" ');assert.match(plain,/fill="#272727" opacity="0.25"/);assert.match(svg,/fill="#FFFFFF" fill-opacity="0.4".*opacity="0.5"/);assert.match(svg,/stroke="#FF0000".*opacity="1"/);new Resvg(svg).render().asPng();
  const outlined=validateAudit([{...text,color:'#272727',opacity:1},{...shape,fill:'none',color:'#ff0000',opacity:1,strokeWidth:2}],s,[]);assert.equal(outlined[1].opacity,1);assert.equal(outlined[1].fillOpacity,0);assert.match(nativeSVG(outlined,()=>''),/fill-opacity="0" stroke="#FF0000" stroke-width="2"/,'透明填充必须保留可见描边');
});

test('归一后的RGB与alpha真实写入可编辑PPTX，并保留登记底图',async()=>{
  const dir=path.resolve('work','visual-color-'+Date.now());fs.mkdirSync(dir,{recursive:true});
  const imageFile=path.join(dir,'background.png'),png=new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#fff"/></svg>').render().asPng();fs.writeFileSync(imageFile,png);
  const p={brief:{title:'颜色兼容',cover:false,toc:false,progress:false},slides:[{kind:'content',title:'准确标题',body:[],sources:[]}],materials:[{id:'bg',file:imageFile,kind:'image',generated:true,purpose:'workflow-background',sha256:digest(png)}],concepts:[],selectedTheme:'a',themeAssets:{directions:[{id:'a',assets:{'content-background':{materialId:'bg',normalized:imageFile,previewHash:digest(png),previewReview:{status:'passed'}}}}]}};p.themeAssets.stamp=themeAssetsStamp(p);
  const elements=validateAudit([{key:'title',type:'text',nodeId:'title',text:'准确标题',x:50,y:30,w:800,h:80,size:40,color:'rgba(39,39,39,0.5)',bold:true},{key:'panel',type:'rect',x:50,y:200,w:400,h:200,fill:'rgba(255,255,0,0.4)',opacity:.5},{key:'line',type:'line',x:50,y:500,w:400,h:1,fill:'none',color:'#ff000080',strokeWidth:2}],p.slides[0],[]);
  p.reconstruction={slides:[{elements,background:slideBackground(p,0)}]};const deck=path.join(dir,'deck.pptx');await buildVisualDeck(p,deck,(_p,id)=>p.materials.find(m=>m.id===id).file);
  const zip=await JSZip.loadAsync(fs.readFileSync(deck)),xml=await zip.file('ppt/slides/slide1.xml').async('string');
  assert.match(xml,/<p:bg>/);assert.match(xml,/<a:srgbClr val="272727"><a:alpha val="50000"/);assert.match(xml,/<a:srgbClr val="FFFF00"><a:alpha val="20000"/);assert.match(xml,/<a:srgbClr val="FF0000"><a:alpha val="50196"/);assert.doesNotMatch(xml,/val="#/);
});
