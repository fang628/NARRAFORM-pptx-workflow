"""Reference-guided local extraction: preserve preview pixels, never redraw text."""
import cv2
import numpy as np
from PIL import Image
from cutout_alpha import prepare_cutout


def reference_cutout(image, background, artistic=False):
    foreground = image.convert('RGBA')
    rgb = np.asarray(foreground)[:, :, :3].astype(np.float32)
    bg = np.asarray(background.convert('RGB').resize(foreground.size, Image.Resampling.LANCZOS)).astype(np.float32)
    distance = np.linalg.norm(rgb-bg, axis=2)
    border = np.concatenate((distance[0], distance[-1], distance[:, 0], distance[:, -1]))
    median = float(np.median(border))
    mad = float(np.median(np.abs(border-median)))
    # A drifting/recomposed background cannot be treated as a reliable matte.
    if median > 65 or mad > 28:
        raise ValueError('预览与底图差异过大，无法可靠本地分离，已保留原文字与页面')
    threshold = max(28., median+5*mad)
    mask = (distance > threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    minimum = max(3, int(mask.size*.00005))
    largest = max([int(row[cv2.CC_STAT_AREA]) for row in stats[1:]] or [0])
    keep = np.zeros_like(mask)
    for i in range(1, count):
        x,y,w,h,area=stats[i]
        touches=x==0 or y==0 or x+w==mask.shape[1] or y+h==mask.shape[0]
        # A small shape entering from a crop edge is usually a neighbouring
        # decoration, not a detached stroke. Keep substantial edge strokes.
        edge_ok = not touches or (area==largest if artistic else area >= max(minimum,largest*.01))
        if area >= minimum and edge_ok:
            keep[labels == i] = 1
    if artistic:
        core=np.zeros_like(mask)
        large=max(minimum,int(largest*.003))
        for i in range(1,count):
            if stats[i,cv2.CC_STAT_AREA]>=large and np.any(keep[labels==i]):core[labels==i]=1
        if core.any():
            near=cv2.distanceTransform((1-core).astype(np.uint8),cv2.DIST_L2,3)
            reach=max(12,min(24,mask.shape[0]*.06))
            for i in range(1,count):
                if minimum<=stats[i,cv2.CC_STAT_AREA]<large and np.any(keep[labels==i]) and float(near[labels==i].min())>reach:keep[labels==i]=0
    coverage = float(keep.mean())
    border_coverage = float(np.concatenate((keep[0],keep[-1],keep[:,0],keep[:,-1])).mean())
    if coverage < .002 or coverage > .78 or border_coverage > .18:
        raise ValueError('本地分离边界或前景占比不可靠，请细化目标位置，已保留原页面')
    alpha = np.clip((distance-threshold)/max(18., threshold*1.3),0,1)*keep
    # Preserve source ink colours exactly; aggressive unmatting creates neon
    # fringes when the AI preview has slightly changed the registered background.
    rgba = np.dstack((rgb.astype(np.uint8),(alpha*255).astype(np.uint8)))
    result, report = prepare_cutout(Image.fromarray(rgba))
    report.update(mode='registered-background-difference',coverage=coverage,threshold=threshold,borderDifference=median)
    return result, report
