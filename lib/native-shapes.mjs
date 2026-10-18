export const nativeShapeKinds=['roundRect','triangle','rtTriangle','diamond','hexagon','pentagon','chevron','parallelogram','trapezoid','rightArrow','leftArrow','upArrow','downArrow','leftRightArrow','upDownArrow'];
export function nativeShapeGeometry(e){
  const {x,y,w,h}=e,p=(a,b)=>`${x+a*w},${y+b*h}`;
  const points={triangle:[[.5,0],[1,1],[0,1]],rtTriangle:[[0,0],[1,1],[0,1]],diamond:[[.5,0],[1,.5],[.5,1],[0,.5]],hexagon:[[.25,0],[.75,0],[1,.5],[.75,1],[.25,1],[0,.5]],pentagon:[[.5,0],[1,.38],[.81,1],[.19,1],[0,.38]],chevron:[[0,0],[.75,0],[1,.5],[.75,1],[0,1],[.25,.5]],parallelogram:[[.25,0],[1,0],[.75,1],[0,1]],trapezoid:[[.2,0],[.8,0],[1,1],[0,1]]};
  const notch=Math.min(w,h)*(e.adjustments?.adj??50000)/100000/w;points.chevron=[[0,0],[1-notch,0],[1,.5],[1-notch,1],[0,1],[notch,.5]];
  if(e.shape==='hexagon'&&e.adjustments?.adj!==undefined){const inset=Math.min(.5,Math.min(w,h)*e.adjustments.adj/100000/w);points.hexagon=[[inset,0],[1-inset,0],[1,.5],[1-inset,1],[inset,1],[0,.5]];}
  const arrow=head=>[[0,.25],[1-head,.25],[1-head,0],[1,.5],[1-head,1],[1-head,.75],[0,.75]],double=head=>[[0,.5],[head,0],[head,.25],[1-head,.25],[1-head,0],[1,.5],[1-head,1],[1-head,.75],[head,.75],[head,1]];
  const horizontal=Math.min(w,h)*.5/w,vertical=Math.min(w,h)*.5/h,right=arrow(horizontal),down=arrow(vertical);
  Object.assign(points,{rightArrow:right,leftArrow:right.map(([a,b])=>[1-a,b]),upArrow:down.map(([a,b])=>[b,1-a]),downArrow:down.map(([a,b])=>[b,a]),leftRightArrow:double(horizontal),upDownArrow:double(vertical).map(([a,b])=>[b,a])});
  return e.shape==='roundRect'?`rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w,h)*(e.adjustments?.adj??16667)/100000}"`:`polygon points="${points[e.shape].map(([a,b])=>p(a,b)).join(' ')}"`;
}
