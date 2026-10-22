// Native DrawingML uses bare RGB; SVG paint attributes require CSS colors.
// Repair only unambiguous hex values, without changing gradients or geometry.
export const svgColorVersion=1;
export function normalizeSVGColors(source){
  return String(source).replace(/(\s(?:fill|stroke|stop-color|flood-color|color)\s*=\s*)(["'])([^"']*)\2/g,(match,prefix,quote,value)=>{
    const hex=value.trim();
    return /^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)?prefix+quote+'#'+hex.toUpperCase()+quote:match;
  });
}
export function normalizeSVGDataURL(url){
  if(typeof url!=='string'||!/^data:image\/svg\+xml;base64,/i.test(url))return url;
  const comma=url.indexOf(','),source=Buffer.from(url.slice(comma+1),'base64').toString('utf8'),normalized=normalizeSVGColors(source);
  return normalized===source?url:url.slice(0,comma+1)+Buffer.from(normalized).toString('base64');
}
