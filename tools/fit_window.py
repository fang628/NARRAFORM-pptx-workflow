"""Keep window boundaries out of measured silhouettes."""

import math

import cv2
import numpy as np


def touches_window(bounds, shape, margin=1):
    x, y, width, height = bounds
    return (x <= margin or y <= margin or x + width >= shape[1] - margin
            or y + height >= shape[0] - margin)


def complete_components(image, box, padding, mask_for, eligible, extra_padding):
    """Return complete matching components, retrying once when a match is clipped."""
    x, y, width, height = box
    pad_x, pad_y = padding
    for extra in (0, extra_padding):
        left = max(0, math.floor(x - pad_x - extra))
        top = max(0, math.floor(y - pad_y - extra))
        right = min(image.shape[1], math.ceil(x + width + pad_x + extra))
        bottom = min(image.shape[0], math.ceil(y + height + pad_y + extra))
        if left >= right or top >= bottom:
            return []
        mask = mask_for(image[top:bottom, left:right])
        _, _, stats, centers = cv2.connectedComponentsWithStats(mask, 8)
        candidates = []
        clipped = False
        for (a, b, w, h, area), (cx, cy) in zip(stats[1:], centers[1:]):
            bounds = (left + a, top + b, w, h)
            center = (left + cx, top + cy)
            if not eligible(bounds, center, area):
                continue
            if touches_window((a, b, w, h), mask.shape):
                clipped = True
            else:
                candidates.append((bounds, center))
        if not clipped or extra:
            return candidates
    return candidates


def thin_fill_box(box):
    width, height = box[2:]
    return min(width, height) <= 14 and max(width, height) >= 3 * max(1, min(width, height))


def supported_thin_ends(points, box, distance, valid):
    """Check both short ends independently of the much longer sides."""
    points = np.asarray(points, float)
    if len(points) < 3:
        return False
    axis = 0 if box[2] >= box[3] else 1
    cross = 1 - axis
    lo, hi = points[:, cross].min(), points[:, cross].max()
    following = np.roll(points, -1, axis=0)
    ends = ([], [])
    for at in np.linspace(lo + .22*(hi-lo), hi - .22*(hi-lo), 16):
        hits = (points[:, cross] > at) != (following[:, cross] > at)
        a, b = points[hits], following[hits]
        if len(a) < 2:
            continue
        along = a[:, axis] + (b[:, axis]-a[:, axis]) * (at-a[:, cross]) / (b[:, cross]-a[:, cross])
        for samples, pos in zip(ends, (along.min(), along.max())):
            samples.append((pos,at) if axis == 0 else (at,pos))
    for samples in ends:
        if len(samples) < 6:
            return False
        xx, yy = np.rint(samples).astype(int).T
        inside = (xx >= 0) & (xx < distance.shape[1]) & (yy >= 0) & (yy < distance.shape[0])
        xx, yy = xx[inside], yy[inside]
        visible = valid[yy,xx] if valid is not None else np.ones(len(xx),bool)
        if visible.sum() < 6 or np.percentile(distance[yy[visible],xx[visible]],90) > 3:
            return False
    return True
