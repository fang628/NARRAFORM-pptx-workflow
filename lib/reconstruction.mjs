import {progressSectionsOf} from './progress-navigation.mjs';
import crypto from 'node:crypto';
function reconstructionStamp(p){const theme=p.concepts.find(t=>t.id===p.selectedTheme);return crypto.createHash('sha256').update(JSON.stringify({slides:p.slides,brief:p.brief,progressSections:progressSectionsOf(p),theme,materials:p.materials.filter(m=>m.kind==='image').map(m=>({id:m.id,sha256:m.sha256}))})).digest('hex');}
export const reconstructionCurrent=p=>!!p.reconstruction&&p.reconstruction.stamp===reconstructionStamp(p);
