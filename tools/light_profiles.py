"""Check for an independently visible narrow light core, not just a halo ridge."""
import numpy as np
import cv2


def light_profiles(ref,background,elements):
    result=[]
    for e in elements:
        if e.get('effectKind')!='lit-stroke' or e.get('effectOf') or e.get('type')!='svg':continue
        x0=max(0,int(e['x']));y0=max(0,int(e['y']));x1=min(1600,int(np.ceil(e['x']+e['w'])));y1=min(900,int(np.ceil(e['y']+e['h'])))
        image=ref[y0:y1,x0:x1].astype(float)
        if min(image.shape[:2])<5 or max(image.shape[:2])<40:continue
        if image.shape[0]>image.shape[1]:image=image.transpose(1,0,2)
        if image.shape[1]<image.shape[0]*3:continue
        # Estimate the broad local illumination independently at each station.
        profiles=[];widths=[];positions=[]
        for x in np.linspace(3,image.shape[1]-4,min(90,image.shape[1]//3)).astype(int):
            colors=np.median(image[:,x-2:x+3],axis=1);base=np.median(np.vstack([colors[:2],colors[-2:]]),axis=0)
            energy=np.linalg.norm(colors-base,axis=1);peak=int(np.argmax(energy));height=float(energy[peak])
            if height<18:profiles.append(False);continue
            active=energy>=height*.65;left=right=peak
            while left>0 and active[left-1]:left-=1
            while right<len(active)-1 and active[right+1]:right+=1
            width=right-left+1;widths.append(width);positions.append(peak)
            profiles.append(width<=4 and 1<peak<len(active)-2)
        support=float(np.mean(profiles)) if profiles else 0
        coherence=float(np.mean(abs(np.diff(positions))<=3)) if len(positions)>8 else 0
        confirmed=support>=.75 and coherence>=.85
        result.append({'key':e['key'],'coreConfirmed':confirmed,'confidence':.9 if confirmed or support<.35 else .65,'coherentSupport':round(support,3),'continuity':round(coherence,3),'medianWidth':float(np.median(widths)) if widths else None,'reason':'连续窄亮芯支持充分' if confirmed else '局部柔光或零散亮脊不足以证明独立发光线'})
    return result
