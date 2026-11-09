"""Conservative background-only translation evidence; never warp delivery art."""
import cv2
import numpy as np


def registered_background(reference, background, excluded=()):
    report={'status':'unchanged','applied':False}
    size=(400,225)
    ref=cv2.resize(reference,size).astype(np.float32)
    bg=cv2.resize(background,size).astype(np.float32)
    diff=np.mean(abs(ref-bg),axis=2)
    # Leave pixel-equal backgrounds untouched. No registration search can improve
    # them, and foreground changes must not move the background to chase content.
    if np.percentile(diff,40)<1:return background,report
    trust=diff<min(30,max(8,float(np.percentile(diff,55))))
    for l,t,r,b in excluded:trust[max(0,t//4):min(225,(b+3)//4),max(0,l//4):min(400,(r+3)//4)]=False
    yy,xx=np.indices(trust.shape)
    hold=(xx//16+yy//16)%3==0
    gray=lambda a:cv2.cvtColor(a,cv2.COLOR_RGB2GRAY)/255
    a,b=gray(ref),gray(bg)
    edges=cv2.Canny(bg.astype(np.uint8),30,80)>0
    if trust.mean()<.25 or np.count_nonzero(edges&trust)<100:return background,{**report,'status':'insufficient-background'}
    try:
        shift,response=cv2.phaseCorrelate(a,b)
        if response<.08 or max(abs(shift[0]),abs(shift[1]))>1.5:return background,{**report,'status':'unstable-translation'}
        warp=np.array([[1,0,shift[0]],[0,1,shift[1]]],np.float32)
        score,warp=cv2.findTransformECC(a,b,warp,cv2.MOTION_TRANSLATION,
            (cv2.TERM_CRITERIA_COUNT|cv2.TERM_CRITERIA_EPS,25,1e-5),(trust&~hold).astype(np.uint8)*255,3)
        translation=warp[:,2]*4
        if not np.isfinite(warp).all() or not np.isfinite(score) or max(abs(translation))>3 or score<.7:return background,{**report,'status':'rejected-transform'}
        full=warp.copy();full[:,2]=translation
        aligned=cv2.warpAffine(background,full,(background.shape[1],background.shape[0]),flags=cv2.INTER_LINEAR|cv2.WARP_INVERSE_MAP,borderMode=cv2.BORDER_REFLECT)
        trial=cv2.resize(aligned,size).astype(np.float32)
        selected=trust&hold
        if np.count_nonzero(selected)<200:return background,{**report,'status':'insufficient-heldout-background'}
        before=float(np.mean(abs(ref-bg)[selected]));after=float(np.mean(abs(ref-trial)[selected]))
        if before-after<1 or after>before*.8:return background,{**report,'status':'no-heldout-improvement'}
        return aligned,{'status':'available','applied':True,'analysisOnly':True,'translation':[float(v) for v in translation],'beforeError':before,'afterError':after}
    except cv2.error:
        return background,{**report,'status':'registration-unavailable'}
