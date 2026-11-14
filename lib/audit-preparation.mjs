import {normalizeAuditIdentities} from './audit-identities.mjs';
import {routeRebuildRepresentations} from './rebuild-representation.mjs';
import {prepareRecognitionGroups} from './recognition-groups.mjs';
import {normalizeNativeParameters} from './native-parameter-groups.mjs';

// Shared by live audits and saved-response replay. Keep relations, not just elements.
export function prepareAuditRelations(raw,{previousGroups=[]}={}){
  if(!Array.isArray(raw?.elements))return {raw,groups:[],changes:[],decisions:[]};
  const normalized=normalizeAuditIdentities(raw);
  const prepared=prepareRecognitionGroups({...normalized,elements:routeRebuildRepresentations(normalized.elements)},{previousGroups});
  const paint=normalizeNativeParameters(prepared.raw.elements,{allowedParameters:['fill','stroke','strokeWidth','strokeColor','gradientAngle','gradientCenter','gradientStops']});
  return {...prepared,raw:{...prepared.raw,elements:paint.elements},decisions:paint.decisions};
}
