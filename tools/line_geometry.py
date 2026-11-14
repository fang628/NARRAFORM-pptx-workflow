"""Shared open-path geometry for fitting, completion and fallback masks."""
import math
import cv2
import numpy as np


def commands_for(e):
    commands=(e.get('linePath') or {}).get('commands')
    if commands:return commands
    return [{'op':'M','points':[[int(bool(e.get('flipH'))),int(bool(e.get('flipV')))]]},
            {'op':'L','points':[[int(not e.get('flipH')),int(not e.get('flipV'))]]}]


def path_model(e):
    commands=commands_for(e);controls=[np.asarray(commands[0]['points'][0],float)];segments=[];start=0
    for c in commands[1:]:
        ids=[start]
        for p in c['points']:ids.append(len(controls));controls.append(np.asarray(p,float))
        segments.append((c['op'],ids));start=ids[-1]
    controls=np.asarray(controls)*[max(.01,e['w']),max(.01,e['h'])]+[e['x'],e['y']];basis=[]
    for op,ids in segments:
        span=sum(np.linalg.norm(controls[b]-controls[a]) for a,b in zip(ids,ids[1:]));count=min(240,max(16,round(span/2)))
        for t in np.linspace(0,1,count):
            n=len(ids)-1;row=np.zeros(len(controls))
            for k,i in enumerate(ids):row[i]=math.comb(n,k)*t**k*(1-t)**(n-k)
            basis.append(row)
    return controls,segments,np.asarray(basis)


def straight_edges(e):
    controls,segments,_=path_model(e)
    return [(controls[ids[0]],controls[ids[-1]]) for op,ids in segments if op=='L']


def snap_nodes(e):
    line=e.get('linePath') or {};nodes=line.pop('nodes',[])
    if not nodes:return
    commands=commands_for(e);scale=np.maximum(.01,[e['w'],e['h']]);vertices=np.array([c['points'][-1] for c in commands]);anchors=[0,len(vertices)-1]
    for i in range(1,len(vertices)-1):
        before=commands[i]['points'][-2] if len(commands[i]['points'])>1 else vertices[i-1]
        after=commands[i+1]['points'][0];a=(vertices[i]-before)*scale;b=(after-vertices[i])*scale
        angle=math.degrees(math.acos(float(np.clip(a@b/max(1e-9,np.linalg.norm(a)*np.linalg.norm(b)),-1,1))))
        if angle>3:anchors.append(i)
    kept={};terminals=line.get('terminals',{})
    for n in nodes:
        index=min(anchors,key=lambda i:np.linalg.norm((vertices[i]-n['position'])*scale));distance=float(np.linalg.norm((vertices[index]-n['position'])*scale))
        if distance>min(18,max(8,n['diameter']*1.5,float(e.get('strokeWidth',1))*3)):continue
        side='begin' if index==0 else 'end' if index==len(vertices)-1 else None
        if side:
            if e.get(side+'ArrowType') not in (None,'none','oval'):continue
            e[side+'ArrowType']='oval';terminals[side]={'diameter':max(n['diameter'],terminals.get(side,{}).get('diameter',0))}
        elif index not in kept or n['diameter']>kept[index]['diameter']:kept[index]={**n,'position':vertices[index].tolist()}
    if kept:line['nodes']=list(kept.values())
    if terminals:line['terminals']=terminals


def line_alpha(e,size=(1600,900)):
    import copy
    e=copy.deepcopy(e);snap_nodes(e)
    controls,segments,basis=path_model(e);points=basis@controls;scale=np.array(size)/[1600,900]
    mask=np.zeros(size[::-1],np.uint8);width=float(e.get('strokeWidth',1));pixels=max(1,round(width*float(scale.mean())))
    if width<=0:return mask
    dash={'dash':[4,3],'dashDot':[4,3,1,3],'lgDash':[8,3],'lgDashDot':[8,3,1,3],'lgDashDotDot':[8,3,1,3,1,3],'sysDash':[3,2],'sysDot':[1,2]}.get(e.get('dashType'))
    if dash:
        lengths=np.array(dash)*width;arc=np.r_[0,np.cumsum(np.linalg.norm(np.diff(points,axis=0),axis=1))]
        # Render each dash along the sampled path, preserving bends and curves.
        for start in np.arange(0,arc[-1]+1e-6,lengths.sum()):
            for index in range(0,len(lengths),2):
                a=start+lengths[:index].sum();b=min(arc[-1],a+lengths[index])
                if a>=b:continue
                at=np.r_[a,arc[(arc>a)&(arc<b)],b]
                part=np.column_stack([np.interp(at,arc,points[:,i]) for i in (0,1)])
                cv2.polylines(mask,[np.rint(part*scale).astype(np.int32)],False,255,pixels)
    else:cv2.polylines(mask,[np.rint(points*scale).astype(np.int32)],False,255,pixels)
    nodes=list((e.get('linePath') or {}).get('nodes') or [])
    sizes={'sm':2,'med':3,'lg':5}
    for side,tip,inward in [('begin',points[0],controls[1]-points[0]),('end',points[-1],controls[-2]-points[-1])]:
        kind=e.get(side+'ArrowType')
        if not kind or kind=='none':continue
        measured=((e.get('linePath') or {}).get('terminals') or {}).get(side)
        protected=side+'ArrowSize' in e.get('keepParameters',[])
        marker=e.get(side+'ArrowSize') or {};across=width*sizes.get(marker.get('width'),3);along=width*sizes.get(marker.get('length'),3)
        if kind=='oval':
            diameter=measured['diameter'] if measured and not protected else across
            cv2.ellipse(mask,tuple(np.rint(tip*scale).astype(int)),tuple(np.maximum(1,np.rint(diameter/2*scale)).astype(int)),0,0,360,255,-1)
        else:
            outward=-inward/max(1e-9,float(np.linalg.norm(inward)));normal=np.array([-outward[1],outward[0]]);base=tip-outward*along
            polygon=[tip,base+normal*across/2,base-normal*across/2]
            if kind=='diamond':polygon=[tip+outward*along/2,tip+normal*across/2,tip-outward*along/2,tip-normal*across/2]
            if kind=='stealth':polygon=[tip,base+normal*across/2,tip-outward*along*.7,base-normal*across/2]
            shape=np.rint(np.array(polygon)*scale).astype(np.int32)
            if kind=='arrow':cv2.polylines(mask,[shape[[1,0,2]]],False,255,pixels)
            else:cv2.fillPoly(mask,[shape],255)
    for node in nodes:
        center=np.array(node['position'])*[e['w'],e['h']]+[e['x'],e['y']]
        cv2.ellipse(mask,tuple(np.rint(center*scale).astype(int)),tuple(np.maximum(1,np.rint(node['diameter']/2*scale)).astype(int)),0,0,360,255,-1)
    opacity=float(e.get('opacity',1))*float(e.get('colorOpacity',1));gradient=e.get('strokeGradient') or e.get('gradient')
    if gradient and gradient.get('type')=='linear':
        angle=math.radians(gradient.get('angle',0));u=np.array([math.cos(angle),math.sin(angle)])
        yy,xx=np.where(mask>0);p=np.column_stack([xx,yy])/scale
        origin=min(np.array([e['x']+dx*e['w'],e['y']+dy*e['h']])@u for dx,dy in [(0,0),(1,0),(0,1),(1,1)])
        span=max(.01,abs(u[0])*e['w']+abs(u[1])*e['h']);stops=sorted(gradient['stops'],key=lambda s:s['position'])
        alpha=np.interp((p@u-origin)/span,[s['position'] for s in stops],[s.get('opacity',1) for s in stops]);mask[yy,xx]=np.rint(mask[yy,xx]*alpha*opacity).astype(np.uint8)
        return mask
    return np.rint(mask*opacity).astype(np.uint8)
