// Corner order follows the native contour: TL, TR, BR, BL for quadrilaterals.
// Sharing is within an object only; it never links size, slant, paint or position.
import {weightedMedian} from './parameter-confidence.mjs';
export const cornerSymmetryRule='角部先按实测轮廓判定对称关系，四边形角序为左上/右上/右下/左下：左右对称horizontal、对角对应diagonal、所有角相同all。cornerSymmetry仅为候选；程序核对轮廓对称、角部类型、实测尺寸差异及合并后边界误差，再共享对应圆角半径或切角距离。不同类型或明显不同尺寸不强改；不因角部归并改变斜度、宽高、位置、填充。';
const sameType=(corners,indices)=>indices.every(i=>corners[i]?.type===corners[indices[0]]?.type);
export function mergeSymmetricCorners(corners,mode='auto',{points}={}){
  if(!Array.isArray(corners)||corners.length<3)return corners;
  const next=corners.map(c=>({...c}));let groups=[];
  if(mode==='none')return corners;
  const comparable=indices=>{
    if(!sameType(corners,indices))return false;
    const c=corners[indices[0]],field=c.type==='round'?'radius':c.type==='cut'?'distance':null;
    if(!field)return true;
    const values=indices.map(i=>Number(corners[i][field]??corners[i].cut??0));
    const mean=values.reduce((s,v)=>s+v,0)/values.length;
    return values.every(Number.isFinite)&&Math.max(...values)-Math.min(...values)<=Math.max(.015,mean*.35);
  };
  const geometric=kind=>{
    if(!points||points.length!==4)return true;
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
    const cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
    const tolerance=Math.max(2,Math.min(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))*.03);
    return (kind==='horizontal'?[[0,1],[3,2]]:[[0,2],[1,3]]).every(([a,b])=>Math.hypot(points[a][0]+points[b][0]-2*cx,kind==='horizontal'?points[a][1]-points[b][1]:points[a][1]+points[b][1]-2*cy)<=tolerance);
  };
  if((mode==='all'||mode==='auto')&&comparable(corners.map((_,i)=>i))&&(geometric('horizontal')||geometric('diagonal')))groups=[corners.map((_,i)=>i)];
  else if(corners.length===4){
    const horizontal=[[0,1],[3,2]],diagonal=[[0,2],[1,3]];
    groups=mode==='horizontal'?(geometric('horizontal')?horizontal:[]):mode==='diagonal'?(geometric('diagonal')?diagonal:[]):
      geometric('horizontal')&&horizontal.every(comparable)?horizontal:geometric('diagonal')&&diagonal.every(comparable)?diagonal:[];
  }
  for(const indices of groups){
    // Explicit mode does not turn a genuinely cut corner into a round corner.
    if(!comparable(indices))continue;
    const type=corners[indices[0]].type,field=type==='round'?'radius':type==='cut'?'distance':null;
    if(!field)continue;
    const value=weightedMedian(indices.map(i=>({value:Number(corners[i][field]??corners[i].cut??0),weight:corners[i].confidence??1})));
    if(value===undefined)continue;
    for(const i of indices){next[i][field]=value;delete next[i].cut;}
  }
  return JSON.stringify(next)===JSON.stringify(corners)?corners:next;
}
