import crypto from 'node:crypto';

export const materialFactVersion=1;
export function indexMaterialFacts(reading){
  const index=fact=>({...fact,factId:'F'+crypto.createHash('sha256')
    .update(JSON.stringify([materialFactVersion,reading.id,fact.excerptId??null,fact.quote??'',fact.claim??'',fact.location??null]))
    .digest('hex').slice(0,20)});
  return {...reading,...(reading.facts?{facts:reading.facts.map(index)}:{}),
    ...(reading.informationIndex?{informationIndex:{...reading.informationIndex,
      blocks:reading.informationIndex.blocks.map(block=>({...block,facts:(block.facts||[]).map(index)}))}}:{})};
}
export const materialFacts=reading=>reading.informationIndex?.blocks.flatMap(block=>block.facts||[])||reading.facts||[];
