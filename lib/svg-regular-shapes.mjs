import {vectorPathBounds} from './vector-path.mjs';

// Never infer regular polygons from concave, multi-subpath or asymmetric artwork.
export function regularSVGFamily({node,path}){
 if(['circle','ellipse'].includes(node.name))return 'ellipse';
 if(!['polygon','path'].includes(node.name)||path?.length!==7||path[0].op!=='M'||path.at(-1).op!=='Z'
  ||path.slice(1,-1).some(c=>c.op!=='L'))return null;
 const p=path.slice(0,-1).map(c=>c.points[0]);
 const signs=p.map((a,i)=>{const b=p[(i+1)%6],c=p[(i+2)%6];return (b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);});
 if(!signs.every(s=>s>1e-6)&&!signs.every(s=>s< -1e-6))return null;
 const b=vectorPathBounds(path);if(b.w<=0||b.h<=0)return null;
 const cx=b.x+b.w/2,cy=b.y+b.h/2;
 if(p.some(a=>!p.some(v=>Math.hypot((a[0]+v[0]-2*cx)/b.w,(a[1]+v[1]-2*cy)/b.h)<.12)))return null;
 return 'hexagon';
}

export function sameRegularSVGBody(a,b){
 const family=regularSVGFamily(a);if(!family||regularSVGFamily(b)!==family)return false;
 if(JSON.stringify(a.matrix)!==JSON.stringify(b.matrix))return false;
 const x=vectorPathBounds(a.path),y=vectorPathBounds(b.path);
 const dx=Math.abs(x.x+x.w/2-y.x-y.w/2),dy=Math.abs(x.y+x.h/2-y.y-y.h/2);
 return dx<Math.max(1,Math.min(x.w,y.w)*.06)&&dy<Math.max(1,Math.min(x.h,y.h)*.06)
  &&Math.min(x.w/y.w,y.w/x.w,x.h/y.h,y.h/x.h)>.6;
}
