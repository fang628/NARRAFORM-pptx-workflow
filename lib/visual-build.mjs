import {normalizeDirectionalElement} from './directional-geometry.mjs';
import {mergePptxPages} from './pptx-page-reuse.mjs';
import {unifyTitleFonts} from './title-fonts.mjs';
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
import {Resvg} from '@resvg/resvg-js';
import {digest} from './visual-model.mjs';
import {slideBackground} from './slide-background.mjs';
import {containedImageBounds} from './image-geometry.mjs';
import {normalizeSVGColors} from './svg-colors.mjs';

export async function buildVisualDeck(p,destination,getImage,{reuse}={}){
  const previous=reuse?fs.readFileSync(reuse.deck):null,changed=reuse?new Set(reuse.indices):null;
  const pptx=new PptxGenJS();pptx.layout='LAYOUT_WIDE';pptx.title=p.brief.title;pptx.author='NARRAFORM';pptx.lang='zh-CN';pptx.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei',lang:'zh-CN'};
  const svgFallbacks=new Map(),backgrounds=new Map(),pageElements=new Map();
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
    const elements=unifyContentTitleColors(p,unifyTitleFonts(p,page.elements).elements,i).elements;pageElements.set(i,elements);
    for(const original of elements){const e=normalizeDirectionalElement(original);const bounds={x:e.x/120,y:e.y/120,w:e.w/120,h:e.h/120,objectName:e.key};
      if(e.type==='text')slide.addText(e.text,{...bounds,...(e.noWrap||e.role==='navigation'?{wrap:false}:{}),fontFace:e.fontFace||'Microsoft YaHei',fontSize:e.size*.6,...nativeTextSpacingOptions(e),bold:e.bold,italic:e.italic??false,color:e.color,transparency:(1-(e.opacity??1))*100,margin:0,breakLine:false,paraSpaceAfterPt:0,valign:e.valign||'top',align:e.align||'left',rotate:e.rotate,fit:'resize'});
      else if(['rect','ellipse','line','shape'].includes(e.type))slide.addShape(pptx.ShapeType[e.type==='shape'?e.shape:e.type],{...bounds,flipH:e.flipH,flipV:e.flipV,rotate:e.rotate,line:{color:e.color??e.fill,width:(e.strokeWidth??0)*.6,dashType:e.dashType,beginArrowType:e.beginArrowType,endArrowType:e.endArrowType,transparency:e.type==='line'||e.strokeWidth>0?(1-(e.opacity??1)*(e.colorOpacity??1))*100:100},...(e.type!=='line'?{fill:{color:e.fill,transparency:(1-(e.opacity??1)*(e.fillOpacity??1))*100}}:{})});
      else{
        const file=getImage(p,e.id);if(!file||!fs.existsSync(file))throw Error('重建素材不存在');
        const isSVG=path.extname(file).toLowerCase()==='.svg',originalSource=fs.readFileSync(file),source=isSVG?Buffer.from(normalizeSVGColors(originalSource.toString('utf8'))):originalSource;
        if(isSVG)svgFallbacks.set(digest(source),new Resvg(source,{fitTo:{mode:'width',value:Math.max(128,Math.min(3000,Math.ceil(e.w*1.2)))}}).render().asPng());
        slide.addImage({...isSVG?{data:'image/svg+xml;base64,'+source.toString('base64')}:{path:file},...containedImageBounds(source,bounds,{imageFit:e.type==='image'&&e.imageFit==='fill'?'fill':'contain'}),altText:e.artisticText?'书法字：'+e.text:e.description||e.key});
      }
    }
    slide.addNotes([p.brief.speaker?p.slides[i].notes:'','来源材料：'+p.slides[i].sources.join('、')].filter(Boolean).join('\n'));
  }
  await pptx.writeFile({fileName:destination});
  // PptxGenJS on Node embeds SVG but uses a broken-image fallback. Replace it
  // with the independently rendered vector's PNG, leaving SVG and editability intact.
  if(svgFallbacks.size||backgrounds.size){const zip=await JSZip.loadAsync(fs.readFileSync(destination));
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
        const content=await zip.file(map.get(svgId)).async('nodebuffer'),fallback=svgFallbacks.get(digest(content));if(!fallback)throw Error('SVG fallback missing');zip.file(map.get(pngId),fallback);
      }
    }
    fs.writeFileSync(destination,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
  }
  if(previous)fs.writeFileSync(destination,await mergePptxPages(previous,fs.readFileSync(destination),[...changed]));
}
