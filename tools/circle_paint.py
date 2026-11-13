"""Joint paint of repeated circles, using normalized visible interiors once."""
import cv2
import numpy as np
from paint_models import fit_native_paint
from parameter_confidence import confidence,weighted_median,provenance


def rgb(value):
    try:return np.array([int(str(value).lstrip('#')[i:i+2],16) for i in (0,2,4)],float)
    except (ValueError,TypeError):return None


def joint_circle_paint(spec,reference,rows,masks):
    elements={e['key']:e for e in spec['elements']};results={r['key']:r for r in rows}
    alpha_cache={}
    for group in spec.get('circleGroups',[]):
        # Stroke evidence has its own grouping. A fill group never implies a
        # common rim, width or effect; explicit keep/rejection stays per-field.
        rim=[elements[k] for k in group['keys'] if k in elements and k in results
             and elements[k].get('strokeWidth',0)>0 and not elements[k].get('shadow')
             and not any(p in elements[k].get('keepParameters',[]) for p in ('stroke','strokeWidth','strokeColor'))
             and not any(r.get('parameter') in ('stroke','strokeWidth','strokeColor') for r in elements[k].get('recognitionRejections',[]))]
        stroke_clusters=[]
        for e in rim:
            patch=results[e['key']]['properties'];width=patch.get('strokeWidth',e['strokeWidth']);color=rgb(patch.get('color',e.get('color')))
            if color is None or patch.get('strokeGradient') or width<=0:continue
            match=next((g for g in stroke_clusters if all(abs(width-w)<=max(.4,w*.15) and np.linalg.norm(color-c)<25 for _,w,c in g)),None)
            if match is None:stroke_clusters.append([(e,width,color)])
            else:match.append((e,width,color))
        for peers_rim in stroke_clusters:
            if len(peers_rim)<2:continue
            reliable=[(e,w,c) for e,w,c in peers_rim if confidence({**e,**results[e['key']]['properties']},'strokeWidth')>=.55]
            if not reliable:continue
            weights=[confidence({**e,**results[e['key']]['properties']},'strokeWidth') for e,_,_ in reliable]
            width=weighted_median([w for _,w,_ in reliable],weights)
            best=min(reliable,key=lambda row:sum(weight*np.linalg.norm(row[2]-other[2]) for other,weight in zip(reliable,weights)))
            color=''.join(f'{v:02X}' for v in np.round(best[2]).astype(int))
            for e,_,_ in peers_rim:
                results[e['key']]['properties'].update(strokeWidth=round(width,3),color=color)
                if not any(e is source for source,_,_ in reliable):
                    results[e['key']]['properties'].setdefault('parameterEvidence',{})['strokeWidth']=provenance([s['key'] for s,_,_ in reliable],max(weights))
        peers=[elements[k] for k in group['keys'] if k in elements and k in results
               and not any(p in elements[k].get('keepParameters',[]) for p in ('fill','gradient','gradientStops','gradientAngle','gradientCenter'))
               and not any(r.get('parameter') in ('fill','gradientStops') for r in elements[k].get('recognitionRejections',[]))]
        clusters=[]
        for e in peers:
            gradient=e.get('gradient');colors=[rgb(s['color']) for s in (gradient or {}).get('stops',[])] or [rgb(e.get('fill'))]
            if any(c is None for c in colors):continue
            signature=np.mean(colors,axis=0)
            def same_field(other):
                ga=gradient or {};gb=other.get('gradient') or {}
                if ga.get('type')=='linear':
                    delta=abs(ga.get('angle',0)-gb.get('angle',0))%360
                    if min(delta,360-delta)>5:return False
                if ga.get('center')!=gb.get('center'):return False
                sa=ga.get('stops',[]);sb=gb.get('stops',[])
                return len(sa)==len(sb) and all(abs(a.get('position',0)-b.get('position',0))<.03 and abs(a.get('opacity',1)-b.get('opacity',1))<.03 for a,b in zip(sa,sb))
            match=next((g for g in clusters if g['kind']==(gradient or {}).get('type','solid') and same_field(g['members'][0])
                        and all(np.linalg.norm(signature-s)<45 for s in g['signatures'])
                        and abs(g['alpha']-e.get('fillOpacity',1))<.03),None)
            if match is None:clusters.append({'kind':(gradient or {}).get('type','solid'),'alpha':e.get('fillOpacity',1),'signatures':[signature],'members':[e]})
            else:match['members'].append(e);match['signatures'].append(signature)
        for cluster in clusters:
            if len(cluster['members'])<2 or cluster['alpha']<.98:continue
            pixels=[];xs=[];ys=[];contributing=[];weights=[]
            for e in cluster['members']:
                x,y,w,h=[float(e[k]) for k in ('x','y','w','h')]
                left,top=max(0,round(x)),max(0,round(y));right,bottom=min(1600,round(x+w)),min(900,round(y+h))
                yy,xx=np.mgrid[top:bottom,left:right];u=(xx+.5-x)/w;v=(yy+.5-y)/h
                inside=(u-.5)**2+(v-.5)**2<.32**2
                colors=np.array([rgb(s['color']) for s in (e.get('gradient') or {}).get('stops',[])] or [rgb(e.get('fill'))])
                observed=reference[yy,xx].astype(float)
                # Reject background drift and numeral ink using the original
                # declared palette, never an independently fitted wrong fill.
                d=np.min(np.linalg.norm(observed[:,:,None,:]-colors[None,None,:,:],axis=3),axis=2)
                inside &= d<65
                for other in spec['elements']:
                    if other['key']==e['key'] or other.get('type') not in ('text','formula','image','svg','cutout'):continue
                    if not (other['x']<x+w and other['x']+other['w']>x and other['y']<y+h and other['y']+other['h']>y):continue
                    file=masks.get(other['key'])
                    if file:
                        if file not in alpha_cache:
                            image=cv2.imread(str(file),cv2.IMREAD_UNCHANGED)
                            alpha_cache[file]=cv2.resize(image[:,:,3],(1600,900)) if image is not None and image.ndim==3 and image.shape[2]==4 else None
                        alpha=alpha_cache[file]
                        if alpha is not None:inside &= alpha[yy,xx]<8
                if inside.sum()<6:continue
                geometry=e.get('geometryEvidence') or {}
                if geometry.get('accepted') is False:continue
                score=min(1.,float(inside.sum())/max(6,w*h*.2))*float(geometry.get('support',.8))
                if score<.55:continue
                # Equal normalized sample budgets prevent a larger instance
                # from winning solely because it supplies more pixels.
                indices=np.flatnonzero(inside);indices=indices[np.linspace(0,len(indices)-1,min(len(indices),max(6,round(80*score)))).astype(int)]
                pixels.extend(observed.reshape(-1,3)[indices]);xs.extend(u.ravel()[indices]*100);ys.extend(v.ravel()[indices]*100);contributing.append(e['key']);weights.append(score)
            if not contributing or len(pixels)<6:continue
            pixels=np.array(pixels);xs=np.array(xs);ys=np.array(ys);template={'x':0,'y':0,'w':100,'h':100}
            representative=cluster['members'][0];current=representative.get('gradient') or representative.get('fill')
            patch=None
            if cluster['kind']=='solid' or np.mean(np.std(pixels,axis=0))<3:
                fill=''.join(f'{c:02X}' for c in np.round(np.median(pixels,axis=0)).astype(int));patch={'fill':fill,'gradient':None}
            elif len(pixels)>=80:
                fitted=fit_native_paint(pixels,xs,ys,template,current)
                if fitted:patch={'gradient':fitted['gradient'],'fill':fitted['gradient']['stops'][0]['color']}
                elif np.sqrt(np.mean((pixels-np.median(pixels,axis=0))**2))<6:
                    patch={'fill':''.join(f'{c:02X}' for c in np.round(np.median(pixels,axis=0)).astype(int)),'gradient':None}
            # When a shared gradient is already accurate, preserve its complete
            # source rather than splitting identical tiny objects into models.
            if patch is None and len({str(e.get('gradient')) for e in cluster['members']})==1:patch={'gradient':representative.get('gradient'),'fill':representative.get('fill')}
            if patch:
                for e in cluster['members']:
                    results[e['key']]['properties'].update(patch)
                    results[e['key']]['properties'].setdefault('parameterEvidence',{})['fill']=(
                        {'confidence':max(weights),'independent':True,'source':'joint-reference-pixels','sources':contributing}
                        if e['key']==contributing[0] else provenance(contributing,max(weights)))
                    results[e['key']].setdefault('diagnostics',{})['circleGroup']={'id':group['id'],'members':contributing,'samples':len(pixels),'parameter':'fill'}
