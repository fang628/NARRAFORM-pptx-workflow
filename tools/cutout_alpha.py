"""Conservative alpha recovery for isolated AI assets on neutral studio/checker backgrounds."""
import cv2
import numpy as np
from PIL import Image


def prepare_cutout(image):
    rgba = np.array(image.convert('RGBA'))
    height, width = rgba.shape[:2]
    alpha = rgba[:, :, 3]
    mode = 'provider-alpha'
    if alpha.min() == 255:
        rgb = rgba[:, :, :3].astype(np.int16)
        border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
        neutral = (border.max(axis=1) - border.min(axis=1) <= 24) & (border.min(axis=1) >= 205)
        if neutral.mean() < .97:
            raise ValueError('无法可靠分离复杂底色；请使用支持透明背景的生图通道或重新抠图')
        floor = max(195, float(np.percentile(border.min(axis=1), 2)) - 22)
        background = (rgb.max(axis=2) - rgb.min(axis=2) <= 24) & (rgb.min(axis=2) >= floor)
        foreground = (~background).astype(np.uint8) * 255
        # Fill the exterior contours, preserving enclosed white highlights and details.
        contours, _ = cv2.findContours(foreground, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contours = [c for c in contours if cv2.contourArea(c) >= max(24, width * height * .0005)]
        if not contours:
            raise ValueError('未找到可可靠分离的独立主体')
        mask = np.zeros_like(alpha)
        cv2.drawContours(mask, contours, -1, 255, cv2.FILLED)
        coverage = float((mask > 0).mean())
        if coverage < .005 or coverage > .85 or np.any(mask[0]) or np.any(mask[-1]) or np.any(mask[:, 0]) or np.any(mask[:, -1]):
            raise ValueError('主体边界不可靠，保留原返回图供用户检查')
        alpha = cv2.GaussianBlur(mask, (3, 3), .6)
        rgba[:, :, 3] = alpha
        mode = 'neutral-background-matte'
    ys, xs = np.where(alpha > 4)
    if not len(xs):
        raise ValueError('抠图没有可见主体')
    padding = max(2, min(16, round(max(xs.max()-xs.min(), ys.max()-ys.min()) * .01)))
    box = (max(0, int(xs.min())-padding), max(0, int(ys.min())-padding),
           min(width, int(xs.max())+padding+1), min(height, int(ys.max())+padding+1))
    result = Image.fromarray(rgba).crop(box)
    if result.getchannel('A').getextrema()[0] == 255:
        raise ValueError('抠图仍没有有效透明区域')
    return result, {'mode': mode, 'sourceWidth': width, 'sourceHeight': height,
                    'width': result.width, 'height': result.height, 'trimBox': list(box),
                    'hasTransparency': True, 'hasVisiblePixels': True}
