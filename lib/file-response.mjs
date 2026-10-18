import fs from 'node:fs';

// A file can disappear or become unreadable between planning and streaming.
// Handle stream errors here, otherwise they can crash the entire local server.
export function sendFile(res,file,type,download){
  let stream;
  const missing=()=>{
    if(res.destroyed)return;
    if(res.headersSent){res.destroy();return;}
    res.writeHead(404,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(JSON.stringify({error:'文件不存在或无法读取'}));
  };
  try{if(!fs.statSync(file).isFile()){missing();return;}}
  catch{missing();return;}
  stream=fs.createReadStream(file);
  stream.once('error',missing);
  res.once('close',()=>stream.destroy());
  stream.once('open',()=>{
    if(res.destroyed){stream.destroy();return;}
    res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff',
      ...(type.startsWith('image/svg+xml')?{'content-security-policy':"sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"}:{}),
      ...(download?{'content-disposition':`attachment; filename="${download}"`}:{})});
    stream.pipe(res);
  });
}
