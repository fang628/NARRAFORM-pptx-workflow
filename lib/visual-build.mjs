import {patchNativeFormulas,patchNativeInlineMath,formulaSVG} from './formula-native.mjs';
import {renderSVG} from './render-pool.mjs';
import {normalizeDirectionalElement,normalizeDirectionalElements} from './directional-geometry.mjs';
import {mergePptxPages} from './pptx-page-reuse.mjs';
import {unifyTitleFonts} from './title-fonts.mjs';
import {unifyPageBodyFonts} from './body-fonts.mjs';
import {unifyContentTitleColors} from './title-colors.mjs';
import {applyNativeColorAdjustments} from './color-adjustment.mjs';
import {nativeTextSpacingOptions} from './text-spacing.mjs';
import {applyNativeProgressGeometry} from './native-shapes.mjs';
import {applyNativeGradients} from './visual-gradient.mjs';
import {applyNativeTextEffects,applyNativeShapeEffects} from './native-effects.mjs';
import fs from 'node:fs';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import {imageSize} from 'image-size';
import {digest} from './visual-model.mjs';
import {slideBackground} from './slide-background.mjs';
import {containedImageBounds} from './image-geometry.mjs';
import {normalizeSVGColors} from './svg-colors.mjs';
import {approvedMaterialImagePlan,readMaterialImage} from './material-image-insertion.mjs';
import {nativeInlineTextParts} from '../public/inline-text.js';
import {hasRunStyles,normalizeTextPaint,styledTextParts} from './styled-text.mjs';
import {normalizeNativeAppearance} from './native-appearance-policy.mjs';
import {nativeScriptOptions} from './script-metrics.mjs';
import {normalizeTableTypography} from './table-typography.mjs';
import {registerLocalComponents,localComponentInventory,localComponentVersion} from './local-components.mjs';
import {groupSlideComponents} from './pptx-local-groups.mjs';
import {connectNativePolylines,joinedSegmentForExport} from './native-polylines.mjs';

export async function buildVisualDeck(p,destination,getImage,{reuse,localGroups=true}={}){
  const previous=reuse?fs.readFileSync(reuse.deck):null,changed=reuse?new Set(reuse.indices):null;
  const pptx=new PptxGenJS();pptx.layout='LAYOUT_WIDE';pptx.title=p.brief.title;pptx.author='NARRAFORM';pptx.lang='zh-CN';pptx.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei',lang:'zh-CN'};
  const svgFallbacks=new Map(),backgrounds=new Map(),pageElements=new Map(),inlineMath=new Map();
  let inlineMathToken=0;
  for(const [i,page] of p.reconstruction.slides.entries()){
    const slide=pptx.addSlide();
    if(changed&&!changed.has(i))continue;
    const background=slideBackground(p,i);
    if(page.background?.id!==background.id||page.background.sha256!==background.sha256)throw Error('重建底图已变化，请重新拆解');
    const backgroundFile=getImage(p,background.id);
    if(!backgroundFile||!fs.existsSync(backgroundFile)||digest(fs.readFileSync(backgroundFile))!==background.sha256)throw Error('页面底图文件缺失或哈希不一致');
    // Let PptxGenJS embed the media/relationship, then promote this temporary
    // picture to p:bg so it is a real PowerPoint background, outside the shape tree.
    const marker='__ppt_agent_background__';
    slide.addImage({path:backgroundFile,x:0,y:0,w:13.333333,h:7.5,objectName:marker});
    backgrounds.set(i+1,marker);
    const registered=registerLocalComponents(page.elements,{nodes:p.slides[i]?.elements||[],previous:page.elements});
    const joined=connectNativePolylines(registered).elements;
    const styled=normalizeTableTypography(normalizeDirectionalElements(unifyContentTitleColors(p,unifyTitleFonts(p,unifyPageBodyFonts(p,joined,i).elements).elements,i).elements).map(normalizeTextPaint).map(normalizeNativeAppearance)).elements;
    const elements=styled.map(e=>joinedSegmentForExport(e,{elements:styled}));pageElements.set(i,elements);
    const materialPlan=approvedMaterialImagePlan(p,i);
    for(const original of elements){const e=normalizeDirectionalElement(original);const bounds={x:e.x/120,y:e.y/120,w:e.w/120,h:e.h/120,objectName:e.key};
      if(e.type==='formula')slide.addText(' ',{...bounds,fontFace:'Cambria Math',fontSize:e.size*.6,margin:0,wrap:false});
      else if(e.type==='text'){
        const textOptions={...bounds,...(e.noWrap||e.role==='navigation'?{wrap:false}:{}),fontFace:e.fontFace||'Microsoft YaHei',fontSize:e.size*.6,...nativeTextSpacingOptions(e),bold:e.bold,italic:e.italic??false,color:e.color,transparency:(1-(e.opacity??1))*100,margin:0,breakLine:false,paraSpaceAfterPt:0,valign:e.valign||'top',align:e.align||'left',rotate:e.rotate,fit:'resize'};
        // pptxgenjs replaces paragraph options when a run supplies its own, so the
        // base font options are merged into every inline run; plain text stays a string.
        // superscript/subscript only adds ±baseline, so script runs shrink to the same
        // 0.68 ratio used by the SVG preview while the remaining font style inherits.
        const parsed=nativeInlineTextParts(e.text);
        // pptxgenjs replaces paragraph options when a run supplies its own, so the
        // base font options are merged into every inline run; plain text stays a string.
        // superscript/subscript only adds ±baseline, so script runs shrink to the same
        // 0.68 ratio used by the SVG preview while the remaining font style inherits.
        const inlineOptions=run=>({...textOptions,...run.options,...nativeScriptOptions(run.options,textOptions.fontSize)});
        let inline=parsed,mathItems=[];
        const styled=hasRunStyles(e),parts=styled?styledTextParts(e):parsed;
        if(styled||Array.isArray(parts)&&parts.some(part=>part.type==='math')){
          inline=parts.map(part=>{
            const style=styled?{color:part.color,bold:part.bold}:{};
            if(part.type==='math'){
              const placeholder='__NARRA_INLINE_MATH_'+i+'_'+(inlineMathToken++)+'__';
              mathItems.push({key:e.key,placeholder,latex:part.latex,size:e.size,color:part.color||e.color,bold:part.bold??e.bold,italic:e.italic,opacity:e.opacity});
              return {text:placeholder,options:style};
            }
            return {text:part.text,options:{...part.options,...style,...(part.script==='sup'?{superscript:true}:part.script==='sub'?{subscript:true}:{})}};
          });
          if(mathItems.length)inlineMath.set(i,[...(inlineMath.get(i)||[]),...mathItems]);
        }
        slide.addText(typeof inline==='string'?inline:inline.map(run=>({text:run.text,options:inlineOptions(run)})),textOptions);
      }
      else if(['rect','ellipse','line','shape'].includes(e.type))slide.addShape(pptx.ShapeType[e.type==='shape'?(e.shape==='freeform'?'rect':e.shape):e.type],{...bounds,flipH:e.flipH,flipV:e.flipV,rotate:e.rotate,line:{color:e.color??e.fill,width:(e.strokeWidth??0)*.6,dashType:e.dashType,beginArrowType:e.beginArrowType,endArrowType:e.endArrowType,transparency:e.type==='line'||e.strokeWidth>0?(1-(e.opacity??1)*(e.colorOpacity??1))*100:100},...(e.type!=='line'?{fill:{color:e.fill,transparency:(1-(e.opacity??1)*(e.fillOpacity??1))*100}}:{})});
      else{
        const planned=materialPlan.find(plan=>plan.nodeId===e.nodeId&&plan.id===e.id);
        if(e.type==='image'&&!e.implementation&&!e.artisticText&&materialPlan.length&&!planned)throw Error('重建原图与批准图片计划不一致：'+e.key);
        // Registered originals are byte-verified against material.sha256 before insertion and keep
        // their original SVG bytes verbatim; only reconstructed SVG assets are colour-normalized.
        const originalMaterial=e.type==='image'&&!e.implementation&&e.artisticText!==true;
        const registered=originalMaterial?readMaterialImage(p,e.id,getImage):null;
        const file=registered?.file||getImage(p,e.id);if(!file||!fs.existsSync(file))throw Error('重建素材不存在');
        const isSVG=path.extname(file).toLowerCase()==='.svg',originalSource=registered?.bytes||fs.readFileSync(file),source=isSVG&&!originalMaterial?Buffer.from(normalizeSVGColors(originalSource.toString('utf8'))):originalSource;
        const placement=containedImageBounds(source,bounds,{imageFit:e.type==='image'&&e.imageFit==='fill'?'fill':'contain'});
        if(isSVG){const key=digest(source),size=imageSize(source),width=Math.max(1,Math.min(3000,Math.max(128,Math.ceil(placement.w*144)),Math.floor(3000*size.width/size.height)));
          if(!svgFallbacks.has(key)||svgFallbacks.get(key).width<width)svgFallbacks.set(key,{width,bytes:await renderSVG(source,{fitTo:{mode:'width',value:width}})});
        }
        slide.addImage({...isSVG?{data:'image/svg+xml;base64,'+source.toString('base64')}:{path:file},...placement,objectName:e.key,altText:e.artisticText?'书法字：'+e.text:e.description||e.key});
      }
    }
    slide.addNotes([p.brief.speaker?p.slides[i].notes:'','来源材料：'+p.slides[i].sources.join('、')].filter(Boolean).join('\n'));
  }
  await pptx.writeFile({fileName:destination});
  // PptxGenJS on Node embeds SVG but uses a broken-image fallback. Replace it
  // with the independently rendered vector's PNG, leaving SVG and editability intact.
  if(svgFallbacks.size||backgrounds.size||inlineMath.size||[...pageElements.values()].some(es=>es.some(e=>e.type==='formula'))){const zip=await JSZip.loadAsync(fs.readFileSync(destination));
    for(const name of Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n))){
      if(changed&&!changed.has(Number(name.match(/slide(\d+)\.xml$/)[1])-1))continue;
      let xml=await zip.file(name).async('string');
      const marker=backgrounds.get(Number(name.match(/slide(\d+)\.xml$/)[1]));
      if(marker){
        const pic=(xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g)||[]).find(pic=>pic.includes('name="'+marker+'"'));
        const rid=pic?.match(/<a:blip[^>]+r:embed="([^"]+)"/)?.[1];
        if(!rid)throw Error('未能写入 PowerPoint 页面背景');
        const bg=`<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${rid}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
        xml=xml.replace(pic,'').replace(/<p:cSld([^>]*)>/,match=>match+bg);
        zip.file(name,xml);
      }
      const page=p.reconstruction.slides[Number(name.match(/slide(\d+)\.xml$/)[1])-1];
      const effectElements=(pageElements.get(Number(name.match(/slide(\d+)\.xml$/)[1])-1)||page.elements).map(normalizeDirectionalElement);
      xml=applyNativeProgressGeometry(applyNativeShapeEffects(applyNativeTextEffects(applyNativeGradients(xml,effectElements),effectElements),effectElements),effectElements);xml=applyNativeColorAdjustments(xml,page.elements,page.background);zip.file(name,xml);
      const rels=await zip.file(name.replace('/slides/','/slides/_rels/')+'.rels').async('string');
      const map=new Map([...rels.matchAll(/<Relationship\s+([^>]+)\/?\s*>/g)].map(m=>{const attrs=Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(x=>[x[1],x[2]]));return [attrs.Id,path.posix.normalize('ppt/slides/'+attrs.Target)];}));
      for(const pic of xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g)||[]){const svgId=pic.match(/<asvg:svgBlip[^>]+r:embed="([^"]+)"/)?.[1],pngId=pic.match(/<a:blip[^>]+r:embed="([^"]+)"/)?.[1];if(!svgId||!pngId)continue;
        const content=await zip.file(map.get(svgId)).async('nodebuffer'),fallback=svgFallbacks.get(digest(content));if(!fallback)throw Error('SVG fallback missing');zip.file(map.get(pngId),fallback.bytes);
      }
    }
    await patchNativeFormulas(zip,p.reconstruction.slides.map((page,i)=>pageElements.get(i)||[]));
    await patchNativeInlineMath(zip,p.reconstruction.slides.map((_,i)=>inlineMath.get(i)||[]));
    fs.writeFileSync(destination,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
  }
  if(localGroups){
    const zip=await JSZip.loadAsync(fs.readFileSync(destination)),reports=[];
    for(const [i,page]of p.reconstruction.slides.entries()){
      if(changed&&!changed.has(i))continue;
      const elements=registerLocalComponents(pageElements.get(i)||page.elements,{nodes:p.slides[i]?.elements||[],previous:page.elements});
      const file=`ppt/slides/slide${i+1}.xml`,result=groupSlideComponents(await zip.file(file).async('string'),elements,localComponentInventory(elements));
      zip.file(file,result.xml);reports.push({index:i,groups:result.records});
    }
    fs.writeFileSync(path.join(path.dirname(destination),path.basename(destination,'.pptx')+'-local-groups.json'),JSON.stringify({version:localComponentVersion,pages:reports},null,2));
    fs.writeFileSync(destination,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
  }
  if(previous)fs.writeFileSync(destination,await mergePptxPages(previous,fs.readFileSync(destination),[...changed]));
}
