export function optionalPageCount(value){
  if(value===undefined||value===null||String(value).trim()==='')return null;
  const count=Number(value);
  if(!Number.isInteger(count)||count<1||count>30)throw Error('页数须在 1–30 之间');
  return count;
}
