import {svgFitTree} from './svg-fitting.mjs';
import {serializeSVGTree} from './svg-tree.mjs';
import {pathD,vectorPathBounds} from './vector-path.mjs';
import {regularSVGFamily,sameRegularSVGBody} from './svg-regular-shapes.mjs';

function hexPoints(path,vertical){
 const b=vectorPathBounds(path),base=vertical?[[.5,0],[1,.25],[1,.75],[.5,1],[0,.75],[0,.25]]:
  [[.25,0],[.75,0],[1,.5],[.75,1],[.25,1],[0,.5]];
 const points=base.map(([x,y])=>[b.x+x*b.w,b.y+y*b.h]);
 const old=path.slice(0,-1).map(c=>c.points[0]),options=[];
 for(const p of [points,[...points].reverse()])for(let i=0;i<6;i++){
  const q=[...p.slice(i),...p.slice(0,i)];options.push({p:q,error:q.reduce((n,v,k)=>n+(v[0]-old[k][0])**2+(v[1]-old[k][1])**2,0)});
 }
 return options.sort((a,b)=>a.error-b.error)[0].p;
}

// Small batches of whole-shape alternatives replace many ineffective vertex nudges.
export function svgShapeCandidates(svg,{curveArrow=false,arrowRole,description='',key=''}={}){
 if(curveArrow||arrowRole==='connector')return [];
 const {layers}=svgFitTree(svg),result=[];
 const hexes=layers.filter(l=>regularSVGFamily(l)==='hexagon');
 if(hexes.length){
  // Only the dominant badge family changes; unrelated symbols retain their geometry.
  const anchor=[...hexes].sort((a,b)=>{const x=vectorPathBounds(a.path),y=vectorPathBounds(b.path);return y.w*y.h-x.w*x.h;})[0];
  const indices=layers.flatMap((l,i)=>sameRegularSVGBody(anchor,l)?[i]:[]);
  for(const vertical of [false,true]){
   const tree=svgFitTree(svg);
   for(const index of indices){const l=tree.layers[index],points=hexPoints(l.path,vertical);
    if(l.node.name==='polygon')l.node.attrs.points=points.map(p=>p.join(',')).join(' ');
    else l.node.attrs.d=pathD([...points.map((p,i)=>({op:i?'L':'M',points:[p]})),{op:'Z',points:[]}]);
   }
   result.push({svg:serializeSVGTree(tree.root),kind:vertical?'hexagon-point-up':'hexagon-flat-top'});
  }
 }
 const value=(layer,name)=>layer.node.attrs[name]??[...layer.parents].reverse().map(p=>p.attrs?.[name]).find(v=>v!==undefined);
 const arcs=layers.filter(l=>value(l,'fill')==='none'&&l.path?.length===2&&l.path[0].op==='M'&&l.path[1].op==='Q'
  &&Math.abs(l.path[1].points[1][0]-l.path[0].points[0][0])>3*Math.abs(l.path[1].points[1][1]-l.path[0].points[0][1])
  &&Math.abs(l.path[1].points[1][0]-l.path[0].points[0][0])>20);
 if(arcs.length){
  const anchor=arcs[0],a=anchor.path[0].points[0],z=anchor.path[1].points[1],span=Math.abs(z[0]-a[0]);
  const indices=layers.flatMap((l,i)=>{
   if(!arcs.includes(l)||JSON.stringify(l.matrix)!==JSON.stringify(anchor.matrix))return [];
   const p=l.path[0].points[0],q=l.path[1].points[1];
   return Math.abs(q[0]-p[0])>span*.65&&Math.abs((p[0]+q[0]-a[0]-z[0])/2)<span*.1
    &&Math.abs((p[1]+q[1]-a[1]-z[1])/2)<Math.max(12,span*.12)?[i]:[];
  });
  for(const scale of [-1,.5,1.5]){
   const tree=svgFitTree(svg);
   for(const index of indices){const l=tree.layers[index],p=structuredClone(l.path),start=p[0].points[0],end=p[1].points[1],control=p[1].points[0];
    const mid=(start[1]+end[1])/2;control[1]=mid+(control[1]-mid)*scale;l.node.attrs.d=pathD(p);
   }
   result.push({svg:serializeSVGTree(tree.root),kind:'linked-arc-curvature-'+scale});
  }
  if(/光环|圆环|椭圆环|\bring\b/i.test(description+' '+key)){
   const view=svgFitTree(svg).root.attrs.viewBox?.trim().split(/[\s,]+/).map(Number);
   // Ring hypotheses compete with the observed open arcs; only reference scores
   // can accept them. Layer count, filters and paint stay exactly as supplied.
   if(view?.length===4&&view.every(Number.isFinite))for(const fraction of [.45,.8]){
    const tree=svgFitTree(svg);
    for(const index of indices){
     const l=tree.layers[index],p=l.path,start=p[0].points[0],end=p[1].points[1];
     const cx=(start[0]+end[0])/2,cy=view[1]+view[3]/2,rx=Math.abs(end[0]-start[0])/2,ry=view[3]*fraction/2*(rx*2/span);
     delete l.node.attrs.d;l.node.name='ellipse';
     Object.assign(l.node.attrs,{cx:String(cx),cy:String(cy),rx:String(rx),ry:String(ry)});
    }
    result.push({svg:serializeSVGTree(tree.root),kind:'declared-ring-ellipse-'+fraction});
   }
  }
 }
 return result.filter(r=>r.svg!==svg).slice(0,7);
}
