// Lightweight wrapping for scene previews; PowerPoint measurements remain authoritative.
export function nativeTextLines(text,width,size,charSpacing=0){
  const lines=[];let line='',used=0;
  for(const char of String(text)){
    const advance=(char.codePointAt(0)>255?size:size*.57)+(line?charSpacing:0);
    if(char==='\n'||used+advance>width&&line){lines.push(line);line='';used=0;}
    if(char!=='\n'){const gap=line?charSpacing:0;line+=char;used+=(char.codePointAt(0)>255?size:size*.57)+gap;}
  }
  if(line||!lines.length||String(text).endsWith('\n'))lines.push(line);
  return lines;
}
