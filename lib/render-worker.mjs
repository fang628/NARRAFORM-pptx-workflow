import {parentPort} from 'node:worker_threads';
import {Resvg} from '@resvg/resvg-js';
parentPort.on('message',({id,source,options})=>{
  try{
    const {__measurePaint,...renderOptions}=options||{},renderer=new Resvg(source,renderOptions);
    if(__measurePaint){
      const b=renderer.getBBox(),bounds=b?{x:b.x,y:b.y,w:b.width,h:b.height}:null;
      if(__measurePaint==='geometry'){parentPort.postMessage({id,measurement:{bounds}});return;}
      const rendered=renderer.render(),pixels=rendered.pixels,w=rendered.width,h=rendered.height;let left=w,top=h,right=-1,bottom=-1;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(pixels[(y*w+x)*4+3]>2){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
      parentPort.postMessage({id,measurement:{bounds,width:w,height:h,paint:right<0?null:{x:left,y:top,w:right-left+1,h:bottom-top+1}}});return;
    }
    const bytes=new Uint8Array(renderer.render().asPng());parentPort.postMessage({id,bytes},[bytes.buffer]);
  }
  catch(error){parentPort.postMessage({id,error:String(error.message)});}
});
