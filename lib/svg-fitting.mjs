import {parseSVGTree,serializeSVGTree,walkSVG,multiplyMatrix,svgTransform} from './svg-tree.mjs';
import {parseVectorPath,pathD,vectorPathBounds,pathTopology} from './vector-path.mjs';
import {geometryNodePath} from './native-carriers.mjs';

const drawable=new Set(['path','polygon','polyline','rect','ellipse','circle','line']);
const definitions=new Set(['defs','clipPath','mask','pattern','filter','symbol']);
const number=n=>String(Math.round(n*1e5)/1e5);
export function svgFitTree(svg){
  const root=parseSVGTree(svg),layers=[];
  walkSVG(root,(node,parents)=>{if(drawable.has(node.name)&&!parents.some(p=>definitions.has(p.name))){const path=geometryNodePath(node);let matrix=[1,0,0,1,0,0];for(const p of [...parents,node])matrix=multiplyMatrix(matrix,svgTransform(p.attrs?.transform||''));layers.push({node,path,matrix,parents});}});
  return {root,layers};
}
export function expandSVGUses(svg){
  const root=parseSVGTree(svg),ids=new Map();walkSVG(root,n=>{if(n.attrs?.id)ids.set(n.attrs.id,n);});let changed=false,instance=0;
  const expand=(parent,trail=[])=>{parent.children=parent.children.map(child=>{
    if(child.name!=='use'){if(!definitions.has(child.name))expand(child,trail);return child;}
    const id=(child.attrs.href||child.attrs['xlink:href']||'').slice(1);if(!id||trail.includes(id)||trail.length>12||!ids.has(id))throw Error('SVG内部引用无效');
    const copy=structuredClone(ids.get(id));delete copy.attrs.id;
    const remap=new Map();walkSVG(copy,n=>{if(n.attrs?.id)remap.set(n.attrs.id,'fit-use-'+(++instance)+'-'+n.attrs.id);});
    walkSVG(copy,n=>{if(!n.attrs)return;for(const [key,value]of Object.entries(n.attrs)){if(key==='id'&&remap.has(value))n.attrs[key]=remap.get(value);else if(['href','xlink:href'].includes(key)&&remap.has(value.slice(1)))n.attrs[key]='#'+remap.get(value.slice(1));else n.attrs[key]=value.replace(/url\(#([^)]*)\)/g,(m,id)=>remap.has(id)?'url(#'+remap.get(id)+')':m);}});
    const {href,'xlink:href':xhref,x,y,...attrs}=child.attrs;
    const group={name:'g',attrs:{...attrs,transform:(attrs.transform||'')+` translate(${Number(x)||0} ${Number(y)||0})`},children:[copy]};expand(group,[...trail,id]);changed=true;return group;
  });};expand(root);return changed?serializeSVGTree(root):svg;
}
export function svgComponentSignature(svg){
  const {layers}=svgFitTree(svg);return layers.map(({node,path})=>({name:node.name,subpaths:pathTopology(path||[]),fillRule:node.attrs['fill-rule']||'nonzero'}));
}
export function mutateSVGTree(svg,parameter,delta){
  const {root,layers}=svgFitTree(svg),target=layers[parameter.layer];if(!target)return svg;
  // Coincident fill, outline and glow copies share one geometric edit. Their
  // different paint/filter properties remain intact.
  const identity=pathD(target.path||[])+'|'+target.matrix.map(number).join(',');
  const linked=layers.filter(layer=>pathD(layer.path||[])+'|'+layer.matrix.map(number).join(',')===identity);
  for(const layer of linked){
    const node=layer.node,a=node.attrs;
    if(parameter.kind==='point'||parameter.kind==='vertex'){
      if(parameter.kind==='vertex'){
        const values=(a.points||'').trim().split(/[\s,]+/).map(Number);if(!Number.isFinite(values[parameter.index]))return svg;values[parameter.index]+=delta;a.points=values.map(number).join(' ');
      }else{
        const commands=parseVectorPath(a.d||'');let at=0,found=false;
        for(const c of commands)for(const p of c.points)for(let k=0;k<2;k++){if(at++===parameter.index){p[k]+=delta;found=true;}}
        if(!found)return svg;a.d=pathD(commands);
      }
      if(JSON.stringify(pathTopology(geometryNodePath(node)))!==JSON.stringify(pathTopology(layer.path)))return svg;
    }else if(parameter.kind==='stroke'){
      const value=Number(a['stroke-width']);if(!Number.isFinite(value)||value<=0)return svg;a['stroke-width']=number(Math.max(.05,value+delta));
    }else{
      const [cx,cy]=parameter.center||[0,0],r=delta*Math.PI/180,c=Math.cos(r),s=Math.sin(r);
      const m=parameter.kind==='tx'?[1,0,0,1,delta,0]:parameter.kind==='ty'?[1,0,0,1,0,delta]:parameter.kind==='sx'?[1+delta,0,0,1,-cx*delta,0]:parameter.kind==='sy'?[1,0,0,1+delta,0,-cy*delta]:parameter.kind==='rotate'?[c,s,-s,c,cx-c*cx+s*cy,cy-s*cx-c*cy]:parameter.kind==='shearX'?[1,0,delta,1,-cy*delta,0]:[1,delta,0,1,0,-cx*delta];
      a.transform='matrix('+m.map(number).join(' ')+') '+(a.transform||'');
    }
  }
  return serializeSVGTree(root);
}
const roundRobin=groups=>{const out=[];for(let i=0;groups.some(g=>i<g.length);i++)for(const g of groups)if(g[i])out.push(g[i]);return out;};
export function svgGeometrySearchStages(svg,box,{allowControlPoints=true}={}){
  const {layers}=svgFitTree(svg),view=parseSVGTree(svg).attrs.viewBox?.trim().split(/[\s,]+/).map(Number);if(view?.length!==4||view.some(n=>!Number.isFinite(n)))return [];
  const placement=['x','y','w','h'].map(field=>({kind:'box',field,step:Math.min(12,box[field==='x'||field==='w'?'w':'h']*.035)}));
  if(box.curveArrow||box.sourceCurveArrow||box.arrowRole==='connector')return [{name:'placement',weight:1,parameters:placement}];
  const components=[],contours=[],stroke=[],used=new Set();
  for(const [layer,part]of layers.entries()){
    const identity=pathD(part.path||[])+'|'+part.matrix.map(number).join(',');if(used.has(identity))continue;used.add(identity);
    const b=vectorPathBounds(part.path),center=[b.x+b.w/2,b.y+b.h/2];
    components.push([{layer,kind:'tx',step:Math.max(.3,b.w*.025),center},{layer,kind:'ty',step:Math.max(.3,b.h*.025),center},{layer,kind:'rotate',step:2,center},{layer,kind:'sx',step:.03,center},{layer,kind:'sy',step:.03,center},{layer,kind:'shearX',step:.025,center},{layer,kind:'shearY',step:.025,center}]);
    if(Number(part.node.attrs['stroke-width'])>0)stroke.push({layer,kind:'stroke',step:Number(part.node.attrs['stroke-width'])*.12});
    if(allowControlPoints){
      if(['polygon','polyline'].includes(part.node.name)){
        const n=(part.node.attrs.points?.match(/[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi)||[]).length;
        contours.push(Array.from({length:Math.min(n,32)},(_,i)=>({layer,kind:'vertex',index:Math.floor(i*n/Math.min(n,32)),step:(i%2?b.h:b.w)*.015})));
      }else if(part.node.name==='path'){
        let cursor=0;const anchors=[],controls=[];for(const c of part.path)for(const [i,p]of c.points.entries()){for(let axis=0;axis<2;axis++)(i===c.points.length-1?anchors:controls).push({layer,kind:'point',index:cursor++,step:(axis?b.h:b.w)*.015});}
        contours.push(roundRobin([anchors,controls]).filter((_,i)=>i%Math.max(1,Math.floor((anchors.length+controls.length)/24))===0).slice(0,24));
      }
    }
  }
  return [{name:'placement',weight:.18,parameters:placement},{name:'components',weight:.25,parameters:roundRobin(components)},
    {name:'contours',weight:.35,parameters:roundRobin(contours)},{name:'stroke',weight:.07,parameters:stroke}];
}
