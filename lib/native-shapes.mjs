export const nativeShapeKinds=['roundRect','triangle','rtTriangle','diamond','hexagon','pentagon','chevron','parallelogram','trapezoid'];
export function nativeShapeGeometry(e){
  const {x,y,w,h}=e,p=(a,b)=>`${x+a*w},${y+b*h}`;
  const points={triangle:[[.5,0],[1,1],[0,1]],rtTriangle:[[0,0],[1,1],[0,1]],diamond:[[.5,0],[1,.5],[.5,1],[0,.5]],hexagon:[[.25,0],[.75,0],[1,.5],[.75,1],[.25,1],[0,.5]],pentagon:[[.5,0],[1,.38],[.81,1],[.19,1],[0,.38]],chevron:[[0,0],[.75,0],[1,.5],[.75,1],[0,1],[.25,.5]],parallelogram:[[.25,0],[1,0],[.75,1],[0,1]],trapezoid:[[.2,0],[.8,0],[1,1],[0,1]]};
  return e.shape==='roundRect'?`rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w,h)*.1667}"`:`polygon points="${points[e.shape].map(([a,b])=>p(a,b)).join(' ')}"`;
}
