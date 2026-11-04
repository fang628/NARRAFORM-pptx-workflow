import {parentPort} from 'node:worker_threads';
import {Resvg} from '@resvg/resvg-js';
parentPort.on('message',({id,source,options})=>{
  try{const bytes=new Uint8Array(new Resvg(source,options).render().asPng());parentPort.postMessage({id,bytes},[bytes.buffer]);}
  catch(error){parentPort.postMessage({id,error:String(error.message)});}
});
