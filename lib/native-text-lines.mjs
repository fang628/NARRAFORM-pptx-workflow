// Lightweight wrapping for scene previews; PowerPoint measurements remain authoritative.
export function nativeTextLines(text,width,size,charSpacing=0){
  const lines=[];let line='',used=0;
  const chars=[...String(text)];
  for(let index=0;index<chars.length;index++){
    const char=chars[index];
    if(/^[A-Za-z0-9]$/.test(char)&&!/^[A-Za-z0-9]$/.test(chars[index-1]||'')){
      let count=0;while(/^[A-Za-z0-9]$/.test(chars[index+count]||''))count++;
      const word=count*size*.57+Math.max(0,count-1)*charSpacing;
      if(line&&used+word>width&&word<=width){lines.push(line);line='';used=0;}
    }
    const advance=(char.codePointAt(0)>255?size:size*.57)+(line?charSpacing:0);
    if(char==='\n'||used+advance>width&&line){lines.push(line);line='';used=0;}
    if(char!=='\n'){const gap=line?charSpacing:0;line+=char;used+=(char.codePointAt(0)>255?size:size*.57)+gap;}
  }
  if(line||!lines.length||String(text).endsWith('\n'))lines.push(line);
  return lines;
}
