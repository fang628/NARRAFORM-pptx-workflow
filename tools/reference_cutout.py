"""Reference-guided local extraction: preserve preview pixels, never redraw text."""
import cv2
import numpy as np
from PIL import Image
from cutout_alpha import prepare_cutout
from refined_matte import reference_matte
from object_masks import object_alpha, mask_entries, crop_alpha


def reference_cutout(image, background, artistic=False, isolation=None):
    foreground = image.convert('RGBA')
    rgb = np.asarray(foreground)[:, :, :3].astype(np.float32)
    bg = np.asarray(background.convert('RGB').resize(foreground.size, Image.Resampling.LANCZOS)).astype(np.float32)
    # Fine trimap matting keeps true holes and thin strokes; a registered base
    # also lets us remove contaminated edge colors before compositing elsewhere.
    try:
        rgba, detail = reference_matte(rgb, bg, artistic)
    except ValueError as error:
        raise ValueError('本地精细分离不可靠，已保留原页面：'+str(error)) from error
    isolation_report=[]
    if isolation:
        entries=mask_entries(isolation)
        source=isolation['sourceBox'];region=isolation['region']
        opaque=rgba[:,:,3]>100
        for other in isolation.get('elements',[]):
            alpha=object_alpha(other,entries)
            overlap=(min(source['x']+source['w'],other['x']+other['w'])>max(source['x'],other['x']) and
                     min(source['y']+source['h'],other['y']+other['h'])>max(source['y'],other['y']))
            if alpha is None:
                if overlap:raise ValueError('目标与邻居 %s 重叠且缺少可验证蒙版，不能将混合对象作为独立素材' % other.get('key'))
                continue
            local=crop_alpha(alpha,region,(rgba.shape[1],rgba.shape[0]))
            foreign=opaque&(local>100)
            count=int(foreign.sum())
            if overlap and count>max(8,int(opaque.sum()*.005)):
                raise ValueError('目标分离混入重叠对象 %s（%s 像素），需要对象级补全或重新提取' % (other.get('key'),count))
            if not overlap:
                rgba[local>16,3]=0
            isolation_report.append({'key':other.get('key'),'overlap':overlap,'foreignPixels':count})
    # Keep the previous target-isolation rule: a tiny component entering from a
    # crop boundary is usually a neighbouring line, not a detached internal tip.
    count, labels, stats, _ = cv2.connectedComponentsWithStats((rgba[:,:,3]>8).astype(np.uint8), 8)
    largest=max([int(row[cv2.CC_STAT_AREA]) for row in stats[1:]] or [0])
    discarded=0
    for i in range(1,count):
        x,y,w,h,area=[int(v) for v in stats[i]]
        touches=x==0 or y==0 or x+w==rgba.shape[1] or y+h==rgba.shape[0]
        if touches and (area<largest if artistic else area<max(3,largest*.01)):
            rgba[labels==i,3]=0
            discarded+=1
    result, report = prepare_cutout(Image.fromarray(rgba), artistic)
    report.update(detail, mode='registered-background-difference', mattingMode=detail['mode'], discardedBorderComponents=discarded, isolation=isolation_report)
    return result, report
