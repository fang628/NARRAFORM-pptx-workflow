"""Measured whole-paint and individual colour-node consensus. Geometry and alpha stay independent."""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from paint_models import fit_native_paint, composite_paint, perceptual_error
from shape_reference import seed_polygon

cv2.setNumThreads(1)
SIZE = (1600, 900)


def rgb(value):
    try:
        value = str(value).lstrip('#')
        return np.array([int(value[i:i+2], 16) for i in (0, 2, 4)], float) if len(value) == 6 else None
    except (ValueError, TypeError):
        return None


def hex_color(value):
    return ''.join('%02X' % int(round(channel)) for channel in np.clip(value, 0, 255))


def lab(value):
    return cv2.cvtColor(np.array(value, np.float32).reshape(1, -1, 3)/255, cv2.COLOR_RGB2LAB)[0]


def load(file):
    value = cv2.imread(str(file)) if file else None
    return cv2.cvtColor(cv2.resize(value, SIZE), cv2.COLOR_BGR2RGB) if value is not None else None


def sample_members(elements, reference, masks, underlays):
    front = np.zeros(reference.shape[:2], np.uint8)
    output = {}
    for element in reversed(elements):
        key = element['key']
        own = cv2.imread(str(masks.get(key, '')), cv2.IMREAD_UNCHANGED) if masks.get(key) else None
        alpha = None
        if own is not None:
            alpha = cv2.resize(own[:, :, 3] if own.ndim == 3 and own.shape[2] == 4 else own[:, :, 0] if own.ndim == 3 else own, SIZE)
        if element.get('type') in ('shape', 'rect', 'ellipse') and not element.get('managed'):
            points = seed_polygon(element)
            if points:
                mask = np.zeros(reference.shape[:2], np.uint8)
                cv2.fillPoly(mask, [np.rint(points).astype(np.int32)], 255)
                eroded = cv2.erode(mask, np.ones((5, 5), np.uint8))
                valid = (eroded > 0) & (front < 16)
                if alpha is not None:
                    valid &= alpha > 16
                yy, xx = np.nonzero(valid)
                if len(xx) >= 80:
                    stride = max(1, len(xx)//2500)
                    xx, yy = xx[::stride], yy[::stride]
                    background = load(underlays.get(key))
                    output[key] = {'pixels': reference[yy, xx].astype(float), 'xx': xx+.5, 'yy': yy+.5,
                                   'background': background[yy, xx].astype(float) if background is not None else None}
                    if float(element.get('strokeWidth') or 0)>=.7:
                        distance=cv2.distanceTransform((mask>0).astype(np.uint8),cv2.DIST_L2,3)
                        ring=(distance>.5)&(distance<=max(1.2,float(element['strokeWidth'])*.45))&(front<16)
                        sy,sx=np.nonzero(ring);step=max(1,len(sx)//2000);sx,sy=sx[::step],sy[::step]
                        bg=background[sy,sx].astype(float) if background is not None else None
                        lower=composite_paint(element.get('gradient') or element.get('fill'),sx+.5,sy+.5,element,bg)
                        if len(sx)>=80:
                            output[key]['stroke']={'pixels':reference[sy,sx].astype(float),'xx':sx+.5,'yy':sy+.5,'background':lower}
        if alpha is not None:
            front = np.maximum(front, cv2.dilate(alpha, np.ones((3, 3), np.uint8)))
        elif element.get('type') in ('text', 'formula', 'image', 'cutout', 'svg'):
            x, y, w, h = [int(round(element.get(name, 0))) for name in ('x', 'y', 'w', 'h')]
            front[max(0,y):min(900,y+h), max(0,x):min(1600,x+w)] = 255
    return output


def save_samples(file, samples):
    arrays={}
    metadata={}
    for index,(key,evidence) in enumerate(samples.items()):
        metadata[key]=index
        for field in ('pixels','xx','yy','background'):
            if evidence.get(field) is not None:arrays[str(index)+'_'+field]=evidence[field]
        for field,value in evidence.get('stroke',{}).items():
            if value is not None:arrays[str(index)+'_stroke_'+field]=value
    arrays['metadata']=np.asarray(json.dumps(metadata))
    np.savez_compressed(file,**arrays)


def read_samples(file):
    output={}
    with np.load(file,allow_pickle=False) as saved:
        for key,index in json.loads(str(saved['metadata'])).items():
            evidence={field:saved[str(index)+'_'+field].copy() if str(index)+'_'+field in saved else None
                      for field in ('pixels','xx','yy','background')}
            stroke={field:saved[str(index)+'_stroke_'+field].copy() if str(index)+'_stroke_'+field in saved else None
                    for field in ('pixels','xx','yy','background')}
            if stroke['pixels'] is not None:evidence['stroke']=stroke
            output[key]=evidence
    return output


def paint_error(element, evidence, paint, stroke=False):
    measured_element={**element,'fillOpacity':element.get('colorOpacity',1)} if stroke else element
    predicted = composite_paint(paint, evidence['xx'], evidence['yy'], measured_element, evidence['background'])
    if predicted is None:
        return None
    residual = np.mean(abs(predicted-evidence['pixels']), axis=1)
    return float(np.mean(residual)), perceptual_error(predicted, evidence['pixels'])


def descriptor(element, evidence):
    # Robust colour field in normalized coordinates; preserves designed hue/contrast differences.
    u = (evidence['xx']-element['x'])/element['w']
    v = (evidence['yy']-element['y'])/element['h']
    bins = np.clip((v*8).astype(int), 0, 7)*8+np.clip((u*8).astype(int), 0, 7)
    return {int(index): np.median(evidence['pixels'][bins == index], axis=0) for index in np.unique(bins)}


def blocked_parameter(element, parameter):
    children={'fill':('gradientAngle','gradientCenter','gradientStops'),
              'stroke':('strokeWidth','strokeColor')}
    if any(name==parameter or parameter in children.get(name,()) or name in children.get(parameter,())
           for name in element.get('keepParameters',[])):
        return True
    if any(row.get('parameter')==parameter or row.get('parameter') in children.get(parameter,())
           for row in element.get('recognitionRejections',[])):
        return True
    groups=element.get('parameterGroups') or {}
    return any(groups.get(name) and groups[name]!=groups.get(parameter)
               for name in children.get(parameter,()))


def merge_whole(elements, samples, records):
    candidates = [e for e in elements if e['key'] in samples and not e.get('tableFittedFill')
                  and not e.get('_stagedSkip') and not blocked_parameter(e,'fill')
                  and (e.get('tableRole') == 'icon' or e.get('parameterGroups', {}).get('fill'))]
    groups = []
    for element in candidates:
        scope = ('explicit', element.get('parameterGroups', {}).get('fill')) if element.get('parameterGroups', {}).get('fill') else (
            'table-icon', element.get('tableId'), element.get('shape') or element['type'], element.get('visualState') or 'normal')
        observed = descriptor(element, samples[element['key']])
        target = None
        for group in groups:
            if group['scope'] != scope:
                continue
            shared = sorted(set(observed) & set(group['descriptor']))
            if len(shared) < 12:
                continue
            differences = np.linalg.norm(lab([observed[i] for i in shared])-lab([group['descriptor'][i] for i in shared]), axis=1)
            if np.median(differences) <= 12 and np.percentile(differences, 85) <= 25:
                target = group
                break
        if target is None:
            groups.append({'scope': scope, 'members': [element], 'descriptor': observed})
        else:
            target['members'].append(element)
    for number, group in enumerate(groups):
        members = group['members']
        if len(members) < 2:
            continue
        # Fit a shared field in physical coordinates with the group's median aspect ratio.
        width = float(np.median([e['w'] for e in members]))
        height = float(np.median([e['h'] for e in members]))
        pixels, xs, ys = [], [], []
        for element in members:
            evidence = samples[element['key']]
            pixels.extend(evidence['pixels'])
            xs.extend((evidence['xx']-element['x'])/element['w']*width)
            ys.extend((evidence['yy']-element['y'])/element['h']*height)
        pixels, xs, ys = np.asarray(pixels), np.asarray(xs), np.asarray(ys)
        template = {'x': 0, 'y': 0, 'w': width, 'h': height}
        # Translucent groups need independent underlays/alpha evidence; node-only sharing handles them.
        if any(e.get('opacity',1)*e.get('fillOpacity',1)<.98 or any(s.get('opacity',1)<.98 for s in (e.get('gradient') or {}).get('stops',[])) for e in members):
            continue
        paints = [e.get('gradient') or e.get('fill') for e in members]
        fit = fit_native_paint(pixels, xs, ys, template, paints[0], budget={'maxCandidates':1800,'seconds':5,
            'sharedInstances':len(members),'maxStops':5})
        if fit:
            paints.append(fit['gradient'])
        scored = []
        for paint in paints:
            errors = [paint_error(e, samples[e['key']], paint) for e in members]
            if all(error is not None for error in errors):
                scored.append((np.mean([error[0] for error in errors]), paint, errors))
        if not scored:
            continue
        _, selected, errors = min(scored, key=lambda item:item[0])
        before = [paint_error(e, samples[e['key']], e.get('gradient') or e.get('fill')) for e in members]
        if any(old is None or new[0] > old[0]+3 or new[1] > old[1]+4 for old,new in zip(before,errors)):
            records.append({'kind':'whole-paint-rejected','keys':[e['key'] for e in members],'reason':'member-error-regression'})
            continue
        group_id = 'measured-fill-'+str(number+1)
        for element in members:
            if isinstance(selected, dict):
                element['gradient'] = selected
                element['fill'] = selected['stops'][0]['color']
            else:
                element['fill'] = selected
                element.pop('gradient', None)
            element['paintConsensus'] = {'wholeFill':group_id,'members':[e['key'] for e in members],
                                         'source':'normalized-visible-colour-field'}
        records.append({'kind':'whole-paint','group':group_id,'keys':[e['key'] for e in members],
                        'before':[round(error[0],3) for error in before],'after':[round(error[0],3) for error in errors]})


def merge_nodes(elements, samples, records):
    nodes = []
    for element in elements:
        if element['key'] not in samples or element.get('_stagedSkip'):
            continue
        for field,solid,stroke in [('gradient','fill',False),('strokeGradient','color',True)]:
            if stroke and 'stroke' not in samples[element['key']]:continue
            if not stroke and element.get('tableFittedFill'):continue
            if blocked_parameter(element,'strokeColor' if stroke else 'gradientStops'):continue
            paint=element.get(field)
            for index,stop in enumerate(paint['stops'] if paint else [{'color':element.get(solid)}]):
                value=rgb(stop.get('color'))
                if value is not None:nodes.append({'element':element,'field':field,'solid':solid,'stroke':stroke,
                    'index':index if paint else None,'rgb':value,'lab':lab([value])[0]})
    groups = []
    for node in nodes:
        scope = node['element'].get('parameterGroups',{}).get('strokeColor' if node['stroke'] else 'gradientStops') or node['element'].get('parameterGroups',{}).get('stroke' if node['stroke'] else 'fill')
        node['scope'] = (node['stroke'],'explicit',scope) if scope else (node['stroke'],'local',node['element'].get('tableId') or node['element'].get('parentKey'),node['element'].get('role') or node['element'].get('tableRole'))
        target=next((g for g in groups if g[0]['scope']==node['scope']
                     and all(np.linalg.norm(other['lab']-node['lab'])<=4.5 for other in g)),None)
        if target is None:
            groups.append([node])
        else:
            target.append(node)
    for number, group in enumerate(groups):
        if len({node['element']['key'] for node in group})<2:
            continue
        representative=min(group,key=lambda a:sum(np.linalg.norm(a['lab']-b['lab']) for b in group))
        color=hex_color(representative['rgb'])
        affected={node['element']['key']:node['element'] for node in group}
        previous={key:json.loads(json.dumps(element)) for key,element in affected.items()}
        for node in group:
            element=node['element']
            if node['index'] is None:
                element[node['solid']]=color
            else:
                element[node['field']]=json.loads(json.dumps(element[node['field']]))
                element[node['field']]['stops'][node['index']]['color']=color
        valid=True
        for key,element in affected.items():
            old=previous[key]
            sample=samples[key].get('stroke') if group[0]['stroke'] else samples[key]
            before=paint_error(old,sample,old.get(group[0]['field']) or old.get(group[0]['solid']),group[0]['stroke'])
            after=paint_error(element,sample,element.get(group[0]['field']) or element.get(group[0]['solid']),group[0]['stroke'])
            if before is None or after is None or after[0]>before[0]+1 or after[1]>before[1]+1.5:
                valid=False
                break
        if not valid:
            for key,element in affected.items():
                element.clear();element.update(previous[key])
            continue
        group_id='measured-colour-node-'+str(number+1)
        for node in group:
            element=node['element']
            element.setdefault('paintConsensus',{}).setdefault('nodes',[]).append({'group':group_id,'field':node['field'],'index':node['index'],'color':color})
        records.append({'kind':'colour-node','group':group_id,'color':color,
                        'members':[{'key':node['element']['key'],'field':node['field'],'index':node['index']} for node in group]})


def main():
    spec=json.loads(Path(sys.argv[1]).read_text(encoding='utf8'))
    elements=json.loads(json.dumps(spec['elements']))
    for element in elements:
        element.pop('paintConsensus',None)
    reference=load(spec['reference'])
    masks={entry['key']:entry['file'] for entry in spec.get('masks',[]) if entry.get('file')}
    samples=read_samples(spec['samplesFile']) if spec.get('samplesFile') else sample_members(elements,reference,masks,spec.get('underlays') or {})
    records=[]
    merge_whole(elements,samples,records)
    merge_nodes(elements,samples,records)
    Path(sys.argv[2]).write_text(json.dumps({'elements':elements,'records':records},ensure_ascii=False,indent=1),encoding='utf8')


if __name__=='__main__':
    main()
