"""S3 joint measured slant consensus for native shape sides and individual open-path segments."""
import copy,math
import cv2
import numpy as np
from parameter_confidence import confidence,weighted_median,parameter_blocked,provenance
from constrained_shapes import _quad_slant_from_properties,_merged_slant_properties
from arrow_geometry_fit import arrow_kind


def pointed_members(e,label):
    from shape_reference import seed_polygon
    polygon=seed_polygon(e)
    if not polygon:return []
    tail=arrow_kind(e);hexagon=e.get('shape')=='hexagon'
    if not tail and not hexagon:return []
    if e.get('customGeometry') and not hexagon:return []
    # A rotated hexagon's head coordinate is its local y axis.
    vertical_hex=False
    if hexagon and e.get('customGeometry'):
        vertices=(e.get('customGeometry') or {}).get('points')
        if not vertices or len(vertices)!=6:return []
        p=np.asarray(vertices,float)
        vertical=(abs(p[0,0]-.5)<.015 and abs(p[0,1])<.015 and abs(p[3,0]-.5)<.015 and abs(p[3,1]-1)<.015)
        horizontal=(abs(p[2,0]-1)<.015 and abs(p[2,1]-.5)<.015 and abs(p[5,0])<.015 and abs(p[5,1]-.5)<.015)
        if not vertical and not horizontal:return []
        vertical_hex=vertical
    parameters=[('headDepth',list(range(6)) if hexagon else [2,3] if tail=='shaft' else [1,2])]
    if tail=='notched':parameters.append(('notchDepth',[4,5]))
    result=[];points=np.asarray(polygon,float)
    for parameter,indices in parameters:
        if parameter_blocked(e,parameter):continue
        specific=(e.get('parameterEvidence') or {}).get(parameter)
        weight=confidence(e,'slant',specific) if specific is not None else confidence(e,'slant')
        for sign in (-1,1):
            selected=[];angles=[]
            for i in indices:
                a,b=points[i],points[(i+1)%len(points)];d=b-a
                angle=math.degrees(math.atan2(abs(d[1]),abs(d[0])))
                if np.linalg.norm(d)<8 or not 3<=angle<=87 or (1 if d[0]*d[1]>0 else -1)!=sign:continue
                selected.append(i);angles.append(angle)
            if selected and max(angles)-min(angles)<=1:
                result.append({'element':e,'angle':float(np.mean(angles)),'sign':sign,'label':label,
                    'confidence':weight,'parameter':parameter,'edgeIndices':selected,
                    'descriptor':{'pointed':True,'symmetric':True,'parameter':parameter,'verticalHex':vertical_hex},
                    'id':e['key']+':'+parameter+':'+str(sign)})
    return result


def members(elements):
    result=[]
    for e in elements:
        if e.get('managed') or e.get('tableId') or e.get('role')=='effect' or e.get('effectOf') or parameter_blocked(e,'slant'):continue
        label=(e.get('parameterGroups') or {}).get('slant')
        if any(k in e.get('keepParameters',[]) for k in ('geometry','linePath','position','x','y')):continue
        if (((e.get('recognitionEvidence') or {}).get('byParameter') or {}).get('slant') or {}).get('source')=='fallback':label=None
        if e.get('type')=='line' and e.get('linePath'):
            commands=e['linePath']['commands'];previous=commands[0]['points'][0]
            for index,c in enumerate(commands[1:],1):
                end=c['points'][-1]
                if c['op']=='L':
                    if parameter_blocked(e,'slant:'+str(index)):previous=end;continue
                    a=np.array(previous)*[e['w'],e['h']]+[e['x'],e['y']];b=np.array(end)*[e['w'],e['h']]+[e['x'],e['y']];d=b-a;length=np.linalg.norm(d)
                    if length>=8:
                        angle=math.degrees(math.atan2(abs(d[1]),abs(d[0])))
                        if 3<=angle<=87:
                            group=(e['linePath'].get('segmentGroups') or {}).get(str(index),label)
                            specific=(e.get('parameterEvidence') or {}).get('slant:'+str(index))
                            result.append({'element':e,'segment':index,'angle':angle,'sign':1 if d[0]*d[1]>0 else -1,'label':group,
                                'confidence':confidence(e,'slant',specific) if specific is not None else confidence(e,'slant'),'a':a,'b':b,'id':e['key']+':'+str(index)})
                previous=end
        elif e.get('type') in ('shape','rect'):
            pointed=pointed_members(e,label)
            if pointed:
                result.extend(pointed);continue
            d=_quad_slant_from_properties(e)
            if d:
                for sign in ([d['sign']] if d['sign'] in (-1,1) else [-1,1]):result.append({'element':e,'angle':d['angle'],'sign':sign,'label':label,'confidence':confidence(e,'slant'),
                    'descriptor':d,'id':e['key']+':edge:'+str(sign)})
    return result


def points_for(member,element):
    if 'segment' in member:
        index=member['segment'];c=element['linePath']['commands'];a=c[index-1]['points'][-1];b=c[index]['points'][-1]
        return np.linspace(np.array(a)*[element['w'],element['h']]+[element['x'],element['y']],np.array(b)*[element['w'],element['h']]+[element['x'],element['y']],48)
    from shape_reference import seed_polygon
    polygon=seed_polygon(element)
    if not polygon:return None
    p=np.asarray(polygon)
    indices=member.get('edgeIndices',range(len(p)))
    return np.concatenate([np.linspace(p[i]+(p[(i+1)%len(p)]-p[i])*.10,p[i]+(p[(i+1)%len(p)]-p[i])*.90,32) for i in indices])


def boundary(points,distance,hidden):
    if points is None:return None
    x=np.clip(np.rint(points[:,0]).astype(int),0,1599);y=np.clip(np.rint(points[:,1]).astype(int),0,899);valid=~hidden[y,x]
    if valid.sum()<12:return None
    d=distance[y[valid],x[valid]];return {'p95':float(np.percentile(d,90)),'cost':float(np.minimum(d,12).mean()),'support':float((d<3).mean())}


def member_boundary(member,element,distance,hidden):
    mask=hidden.get(element['key']) if isinstance(hidden,dict) else hidden
    if mask is None:mask=np.zeros(distance.shape,bool)
    return boundary(points_for(member,element),distance,mask)


def proposal(m,angle):
    e=copy.deepcopy(m['element'])
    if m.get('descriptor',{}).get('pointed'):
        vertical=m['descriptor'].get('verticalHex') or e.get('arrowDirection') in ('up','down')
        length,cross=(e['h'],e['w']) if vertical else (e['w'],e['h'])
        depth=(cross*math.tan(math.radians(angle))/2/length if vertical else cross/2/math.tan(math.radians(angle))/length)
        if not .005<=depth<=.49:return None
        depth=round(depth,7)
        parameter=m['parameter'];g={**(e.get('shapeGeometry') or {})}
        if parameter=='headDepth' and arrow_kind(e)=='notched' and 'notchDepth' not in g:
            from arrow_geometry_fit import initial_depths
            g['notchDepth']=initial_depths(e,[e['x'],e['y'],e['w'],e['h']])[1]
        g[parameter]=round(depth,7)
        if parameter=='headDepth':g.pop('slantAngle',None)
        e['shapeGeometry']=g
        if m['descriptor'].get('verticalHex'):
            e['customGeometry']={'points':[[.5,0],[1,depth],[1,1-depth],[.5,1],[0,1-depth],[0,depth]],'closed':True}
        elif e.get('shape')=='hexagon' and e.get('customGeometry'):
            e['customGeometry']={'points':[[depth,0],[1-depth,0],[1,.5],[1-depth,1],[depth,1],[0,.5]],'closed':True}
        return e
    if 'segment' not in m:return _merged_slant_properties({'properties':e,'family':'quad'},m['descriptor'],angle)
    c=e['linePath']['commands'];i=m['segment'];a=np.array(c[i-1]['points'][-1])*[e['w'],e['h']]+[e['x'],e['y']];b=np.array(c[i]['points'][-1])*[e['w'],e['h']]+[e['x'],e['y']]
    if len(c)==2:
        length=float(np.linalg.norm(b-a));d=np.array([math.cos(math.radians(angle))*np.sign(b[0]-a[0]),math.sin(math.radians(angle))*np.sign(b[1]-a[1])])*length
        center=(a+b)/2;a=center-d/2;b=center+d/2;lo=np.minimum(a,b);size=np.maximum(.01,abs(b-a))
        e.update(x=float(lo[0]),y=float(lo[1]),w=float(size[0]),h=float(size[1]));c[0]['points']=[((a-lo)/size).tolist()];c[1]['points']=[((b-lo)/size).tolist()]
    else:
        # Shared vertices are written once. Keep unrelated vertices, bbox, colour,
        # linewidth and endpoint types; adjacent segments retain a continuous join.
        target=m['sign']*abs(b[1]-a[1])/math.tan(math.radians(angle))*np.sign(b[1]-a[1]);error=target-(b[0]-a[0])
        if abs(error)>4:return None
        movable_a=i>1 and not parameter_blocked(e,'slant:'+str(i-1));movable_b=i<len(c)-1 and not parameter_blocked(e,'slant:'+str(i+1))
        if not movable_a and not movable_b:return None
        da=-error/2 if movable_a and movable_b else -error if movable_a else 0
        db=error/2 if movable_a and movable_b else error if movable_b else 0
        ax=c[i-1]['points'][-1][0]+da/max(.01,e['w']);bx=c[i]['points'][-1][0]+db/max(.01,e['w'])
        if not (0<=ax<=1 and 0<=bx<=1):return None
        c[i-1]['points'][-1][0]=ax;c[i]['points'][-1][0]=bx
        if i>1 and c[i-1]['op'] in ('Q','C'):
            for p in c[i-1]['points'][:-1]:p[0]+=da/max(.01,e['w'])
        if i+1<len(c) and c[i+1]['op'] in ('Q','C'):c[i+1]['points'][0][0]+=db/max(.01,e['w'])
        if any(not 0<=v<=1 for command in c for p in command['points'] for v in p):return None
    from line_path_fit import relocate_nodes
    relocate_nodes(m['element'],e)
    from line_geometry import snap_nodes
    snap_nodes(e)
    return e


def merge(elements,reference,hidden,target_keys=None):
    output=copy.deepcopy(elements);by_key={e['key']:e for e in output};records=[]
    gray=cv2.cvtColor(reference.astype(np.uint8),cv2.COLOR_RGB2GRAY);distance=cv2.distanceTransform(255-cv2.Canny(gray,35,100),cv2.DIST_L2,3)
    candidates=members(output);scopes={};symmetric_angles={}
    for m in candidates:scopes.setdefault((m['sign'],m['label'] or ''),[]).append(m)
    for scope,items in scopes.items():
        items.sort(key=lambda m:m['angle']);groups=[]
        for m in items:
            group=next((g for g in groups if all(abs(m['angle']-p['angle'])<=2 for p in g)),None)
            if group is None:groups.append([m])
            else:group.append(m)
        for group in groups:
            if len({m['element']['key'] for m in group})<2:continue
            if not scope[1]:
                centers=[np.array([m['element']['x']+m['element']['w']/2,m['element']['y']+m['element']['h']/2]) for m in group]
                if any(np.linalg.norm(a-b)>700 for a in centers for b in centers):continue
            # A measured object contributes once even if it has two equivalent sides.
            sources={}
            for m in group:
                if m['confidence']>=.55:sources.setdefault(m['element']['key'],m)
            if not sources:continue
            if max(m['angle'] for m in sources.values())-min(m['angle'] for m in sources.values())>1.:continue
            angle=weighted_median([m['angle'] for m in sources.values()],[m['confidence'] for m in sources.values()]);updates={};valid=True
            symmetric_key=lambda m:(m['element']['key'],m.get('parameter','slant'))
            existing=[symmetric_angles[symmetric_key(m)] for m in group if m.get('descriptor',{}).get('symmetric') and symmetric_key(m) in symmetric_angles]
            if existing:
                if max(existing)-min(existing)>.01:continue
                # Paired symmetric sides share one geometric parameter. A second
                # signed group must reuse it, never tilt the other half differently.
                angle=existing[0]
                if any(abs(m['angle']-angle)>2 for m in group):continue
            for m in group:
                key=m['element']['key']
                if target_keys is not None and key not in target_keys:continue
                m={**m,'element':updates.get(key,by_key[key])};trial=proposal(m,angle)
                neighbours=[]
                if 'segment' in m and trial:
                    for index in (m['segment']-1,m['segment']+1):
                        commands=trial['linePath']['commands']
                        if 0<index<len(commands) and commands[index]['op']=='L':neighbours.append({**m,'segment':index})
                before=member_boundary(m,m['element'],distance,hidden);after=member_boundary(m,trial,distance,hidden) if trial else None
                if not before or not after or after['p95']>before['p95']+.9 or after['cost']>before['cost']+.6 or after['support']<before['support']-.1:
                    valid=False;break
                for neighbour in neighbours:
                    a=member_boundary(neighbour,m['element'],distance,hidden);b=member_boundary(neighbour,trial,distance,hidden)
                    if a and b and (b['p95']>a['p95']+.9 or b['cost']>a['cost']+.6):valid=False;break
                    n=neighbour['segment'];other_label=(trial['linePath'].get('segmentGroups') or {}).get(str(n))
                    if other_label and other_label!=scope[1]:
                        before_points=points_for(neighbour,m['element']);after_points=points_for(neighbour,trial)
                        va=before_points[-1]-before_points[0];vb=after_points[-1]-after_points[0]
                        aa=math.degrees(math.atan2(va[1],va[0]));ab=math.degrees(math.atan2(vb[1],vb[0]))
                        if abs((aa-ab+180)%360-180)>.01:valid=False;break
                if not valid:break
                updates[key]=trial
            if not valid:continue
            # A second segment in the same path may have moved a shared vertex.
            # Verify the actual accumulated proposal, not only intermediate trials.
            for m in group:
                trial=updates.get(m['element']['key'])
                if trial is None:continue
                after=member_boundary(m,trial,distance,hidden);before=member_boundary(m,m['element'],distance,hidden)
                if not after or not before or after['p95']>before['p95']+.9:valid=False;break
            if not valid:continue
            for key,trial in updates.items():
                e=by_key[key];e.clear();e.update(trial)
                evidence={'angle':angle,'group':scope[1] or 'measured-near-slant','sources':list(sources),'members':[m['id'] for m in group],'boundaryChecked':True}
                previous=[item for item in e.get('pathSlantEvidence',[]) if item.get('members')!=evidence['members']]
                e['pathSlantEvidence']=[*previous,evidence]
                for m in group:
                    if m['element']['key']==key and m.get('descriptor',{}).get('symmetric'):symmetric_angles[symmetric_key(m)]=angle
                parameters=['slant:'+str(m['segment']) for m in group if m['element']['key']==key and 'segment' in m]
                parameters.extend(m['parameter'] for m in group if m['element']['key']==key and m.get('parameter'))
                if not parameters and (e.get('type')!='line' or len(e['linePath']['commands'])==2):parameters.append('slant')
                for parameter in parameters:
                    old=(e.get('parameterEvidence') or {}).get(parameter) or {}
                    # A consensus changes this value into an inherited one. Keep
                    # the independent observation separately for diagnostics.
                    inherited=provenance(list(sources),max(m['confidence'] for m in sources.values()))
                    observation=old.get('observation') or (copy.deepcopy(old) if old.get('independent') else None)
                    if observation:inherited['observation']=observation
                    e.setdefault('parameterEvidence',{})[parameter]=inherited
            records.append({'angle':angle,'members':[m['id'] for m in group],'sources':list(sources),'changedKeys':list(updates),'accepted':True})
    return output,records
