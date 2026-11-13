"""Independent parameter observations and robust confidence-weighted estimates."""
import numpy as np


def weighted_median(values, weights):
    values=np.asarray(values,float);weights=np.asarray(weights,float)
    valid=np.isfinite(values)&np.isfinite(weights)&(weights>0)
    if not valid.any():return None
    values,weights=values[valid],weights[valid];order=np.argsort(values)
    values,weights=values[order],weights[order];cumulative=np.cumsum(weights)
    index=int(np.searchsorted(cumulative,cumulative[-1]/2))
    if index+1<len(values) and abs(cumulative[index]-cumulative[-1]/2)<1e-9:return float((values[index]+values[index+1])/2)
    return float(values[index])


def confidence(element, parameter, observation=None):
    evidence=(element.get('parameterEvidence') or {}).get(parameter) or ((element.get('parameterEvidence') or {}).get('fill') if parameter.startswith('gradient') else {}) or {}
    if observation is not None:
        if observation.get('independent') is False:return 0.
        return float(np.clip(observation.get('confidence',0),0,1))
    if evidence.get('inherited') or evidence.get('independent') is False:return 0.
    if 'confidence' in evidence:return float(np.clip(evidence['confidence'],0,1))
    geometry=element.get('geometryEvidence') or {}
    if parameter in ('diameter','slant','corners') and geometry.get('accepted'):
        return float(np.clip(geometry.get('support',geometry.get('visibleCoverage',.8))*(1-min(.6,geometry.get('boundaryP95',0)/12)),0,1))
    return 0.


def provenance(sources, score):
    return {'confidence':round(float(score),4),'independent':False,'inherited':True,
            'sources':list(sources),'method':'reliable-weighted-consensus'}


def parameter_blocked(element,parameter):
    children={'fill':('gradientAngle','gradientCenter','gradientStops'),'stroke':('strokeWidth','strokeColor')}
    keep=element.get('keepParameters',[])
    if any(p==parameter or p in children.get(parameter,()) or parameter in children.get(p,()) for p in keep):return True
    if any(r.get('parameter')==parameter or r.get('parameter') in children.get(parameter,()) for r in element.get('recognitionRejections',[])):return True
    groups=element.get('parameterGroups') or {}
    return any(groups.get(p) and groups[p]!=groups.get(parameter) for p in children.get(parameter,()))


def inherit_measured_parameters(elements, rows):
    """Let independently sampled members supply weak peers within declared groups."""
    by_key={row['key']:row for row in rows}
    for parameter,fields in [('fill',('fill','gradient')),('strokeColor',('color','strokeGradient')),('strokeWidth',('strokeWidth',))]:
        groups={}
        for element in elements:
            label=(element.get('parameterGroups') or {}).get(parameter)
            if not label or element.get('_stagedSkip') or parameter_blocked(element,parameter):continue
            groups.setdefault((label,element.get('visualState','normal')),[]).append(element)
        for members in groups.values():
            sources=[]
            for e in members:
                row=by_key.get(e['key'],{});patch=row.get('properties') or {}
                score=confidence({**e,'parameterEvidence':patch.get('parameterEvidence') or {}},parameter)
                if score>=.55 and any(f in patch for f in fields):sources.append((e,patch,score))
            if not sources:continue
            for e in members:
                if any(e is source for source,_,_ in sources):continue
                row=by_key.get(e['key']);
                if row is None:continue
                current=row.get('properties') or {}
                if confidence({**e,'parameterEvidence':current.get('parameterEvidence') or {}},parameter)>=.55:continue
                # A split of reliable colours cannot be settled by a weak peer.
                def signature(source,patch):
                    gradient=patch.get('gradient' if parameter=='fill' else 'strokeGradient')
                    value=patch.get('fill' if parameter=='fill' else 'color',source.get('fill' if parameter=='fill' else 'color'))
                    colors=[s['color'] for s in (gradient or {}).get('stops',[])] or [value]
                    try:
                        rgb=np.asarray([[int(c[i:i+2],16) for i in (0,2,4)] for c in colors],float)
                        if gradient:
                            t=np.linspace(0,1,5);positions=[s['position'] for s in gradient['stops']]
                            return np.column_stack([np.interp(t,positions,rgb[:,i]) for i in range(3)]).ravel()
                        return np.tile(rgb[0],5)
                    except (ValueError,TypeError):return None
                if parameter=='strokeWidth':
                    values=[p.get('strokeWidth',s.get('strokeWidth',0)) for s,p,w in sources]
                    if max(values)-min(values)>max(.4,min(values)*.15):continue
                    patch={'strokeWidth':weighted_median(values,[w for s,p,w in sources])}
                else:
                    signatures=[signature(s,p) for s,p,w in sources]
                    if any(s is None for s in signatures):continue
                    if any(np.linalg.norm(a-b)>35 for a in signatures for b in signatures):continue
                    source,proposal,weight=max(sources,key=lambda item:item[2])
                    if parameter=='fill':
                        gradient=proposal.get('gradient') or {}
                        current=e.get('gradient') or {}
                        alpha=lambda g:np.interp(np.linspace(0,1,5),[s['position'] for s in g.get('stops',[])],[s.get('opacity',1) for s in g.get('stops',[])]) if g.get('stops') else np.ones(5)
                        if np.max(np.abs(alpha(gradient)-alpha(current)))>.02:continue
                    patch={f:proposal.get(f,source.get(f)) for f in fields}
                row.setdefault('properties',{}).update(patch)
                row['properties'].setdefault('parameterEvidence',{})[parameter]=provenance([s['key'] for s,p,w in sources],max(w for s,p,w in sources))
                row['status']='inherited'
