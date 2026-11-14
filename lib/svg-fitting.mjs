import {parseSVGTree,serializeSVGTree,walkSVG,multiplyMatrix,svgTransform} from './svg-tree.mjs';
import {parseVectorPath,pathD,vectorPathBounds,pathTopology,transformPath} from './vector-path.mjs';
import {geometryNodePath} from './native-carriers.mjs';
import {regularSVGFamily,sameRegularSVGBody} from './svg-regular-shapes.mjs';

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
  if(parameter.whole){
    const view=root.attrs.viewBox.trim().split(/[\s,]+/).map(Number),cx=view[0]+view[2]/2,cy=view[1]+view[3]/2;
    const transform=parameter.kind==='tx'?`translate(${delta} 0)`:parameter.kind==='ty'?`translate(0 ${delta})`:
      parameter.kind==='sx'?`translate(${cx} 0) scale(${1+delta} 1) translate(${-cx} 0)`:
      parameter.kind==='sy'?`translate(0 ${cy}) scale(1 ${1+delta}) translate(0 ${-cy})`:`rotate(${delta} ${cx} ${cy})`;
    const matrix=svgTransform(transform);
    // Generate only transforms that retain the visible drawing in its viewport.
    // Translation through the registered element box can relocate a full SVG;
    // translating its internal paths out of that box silently crops the ends.
    for(const layer of layers){
      const before=vectorPathBounds(transformPath(layer.path,layer.matrix));
      const after=vectorPathBounds(transformPath(layer.path,multiplyMatrix(matrix,layer.matrix)));
      const over=b=>[Math.max(0,view[0]-b.x),Math.max(0,view[1]-b.y),Math.max(0,b.x+b.w-view[0]-view[2]),Math.max(0,b.y+b.h-view[1]-view[3])];
      if(over(after).some((value,i)=>value>over(before)[i]+.25))return svg;
    }
    const existing=root.children.find(n=>n.name==='g'&&n.attrs?.id==='nf-fit-whole');
    if(existing)existing.attrs.transform=transform+' '+(existing.attrs.transform||'');
    else root.children=[...root.children.filter(n=>definitions.has(n.name)),{name:'g',attrs:{id:'nf-fit-whole',transform},children:root.children.filter(n=>!definitions.has(n.name))}];
    return serializeSVGTree(root);
  }
  const component=parameter.component?target.parents.find(p=>p.attrs?.id===parameter.component):null;
  // Coincident fill, outline and glow copies share one geometric edit. Their
  // different paint/filter properties remain intact.
  const identity=pathD(target.path||[])+'|'+target.matrix.map(number).join(',');
  const structural=!['point','vertex','stroke'].includes(parameter.kind)&&regularSVGFamily(target);
  const linked=layers.filter(layer=>pathD(layer.path||[])+'|'+layer.matrix.map(number).join(',')===identity
    ||structural&&sameRegularSVGBody(target,layer));
  for(const layer of component?[{...target,node:component}]:linked){
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
export function svgGeometrySearchStages(svg,box,{allowControlPoints=true}={}){
  const {layers}=svgFitTree(svg),view=parseSVGTree(svg).attrs.viewBox?.trim().split(/[\s,]+/).map(Number);if(view?.length!==4||view.some(n=>!Number.isFinite(n)))return [];
  const placement=['x','y','w','h'].map(field=>({kind:'box',field,step:Math.min(12,box[field==='x'||field==='w'?'w':'h']*.035)}));
  if(svg.includes('id="nf-reference-whole"'))return [{name:'placement',weight:1,parameters:placement}];
  if(box.curveArrow||box.sourceCurveArrow||box.arrowRole==='connector')return [{name:'placement',weight:1,parameters:placement}];
  const stroke=layers.flatMap((part,layer)=>Number(part.node.attrs['stroke-width'])>0?[{layer,kind:'stroke',step:Number(part.node.attrs['stroke-width'])*.12}]:[]);
  // One registered SVG is one geometric object. Independent layer translations
  // destroyed the relative positions of outer frames, inner frames and symbols.
  const whole=[{kind:'tx',step:Math.max(.3,view[2]*.025)},{kind:'ty',step:Math.max(.3,view[3]*.025)},
    {kind:'sx',step:.03},{kind:'sy',step:.03}].map(p=>({...p,layer:0,whole:true}));
  return [{name:'placement',weight:.35,parameters:placement},{name:'components',weight:.5,parameters:whole},
    {name:'stroke',weight:.15,parameters:stroke}];
}
