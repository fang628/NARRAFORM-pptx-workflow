"""Refined local matte against a registered reference background.

The registered background is treated as known: first the border is checked for
background drift/recomposition, then a conservative trimap is built. Reliable
opaque foreground seeds combine contrast extrema, stable source-color platforms
and deep interiors above a contrast threshold; foreground colour diffuses into the unknown
band and alpha is recovered by projecting the observed colour onto the known
background/foreground axis. Edge colours are decontaminated with that same
unmixing, without dilation, blur or contour filling. The whole input canvas is
preserved; callers select the target region through their crop.

Only what the known background supports is claimed: a drifting background, a
foreground too close to the background colour or no reliable opaque seed raises
ValueError so the existing fallback path stays in charge. Uniformly translucent
or fully transparent objects stay inherently ambiguous and are not claimed to
be recovered exactly.

uniform_matte=True relaxes only the broad background-block heuristic, for
callers that already verified an explicit uniform matte (the chroma path): a
legitimate subject may fill most of the crop and be rectangular. Reliable
border, minimum foreground, coverage caps and opaque-seed checks still apply.
The default (False) keeps the registered-background contract unchanged.
"""
import cv2
import numpy as np
cv2.setNumThreads(1)

MODE = 'reference-trimap-edge-matte'
_MIN_PEAK_CONTRAST = 48.0
_MIN_UNMIX_CONTRAST = 24.0
_SOFT_ALPHA = 0.02
_OPAQUE_ALPHA = 0.985


def _rgb_float(array, name):
    value = np.asarray(array)
    if value.ndim != 3 or value.shape[2] < 3:
        raise ValueError('%s 必须是 H×W×3 的 RGB 数组' % name)
    if not np.issubdtype(value.dtype, np.number):
        raise ValueError('%s 必须是数值型 RGB 数组' % name)
    value = value[:, :, :3].astype(np.float32)
    if not np.all(np.isfinite(value)):
        raise ValueError('%s 包含非有限数值' % name)
    return np.clip(value, 0.0, 255.0)


def _border(array):
    return np.concatenate((array[0], array[-1], array[:, 0], array[:, -1]), axis=0)


def reference_matte(rgb, bg, artistic=False, uniform_matte=False):
    """Return (RGBA uint8 HxWx4 on the full canvas, report dict)."""
    source = _rgb_float(rgb, 'rgb')
    base = _rgb_float(bg, 'bg')
    if source.shape != base.shape:
        raise ValueError('rgb 与 bg 必须尺寸一致')
    height, width = source.shape[:2]
    if height < 8 or width < 8:
        raise ValueError('蒙版画布过小，无法可靠估计背景噪声与边界')

    difference = np.linalg.norm(source - base, axis=2)
    border = np.linalg.norm(_border(source) - _border(base), axis=1)
    border_median = float(np.median(border))
    border_mad = float(np.median(np.abs(border - border_median)))
    border_high = float(np.percentile(border, 90))
    border_changed = float((border > 30.0).mean())
    # A registered background matches the preview border; drift or recomposition
    # cannot be trusted as a local matte and must fall back to the old path.
    if border_median > 26.0 or border_mad > 14.0 or border_high > 40.0 or border_changed > 0.22:
        raise ValueError('预览与登记背景的边界差异不可靠（背景漂移或重排），无法建立精细蒙版')

    background_floor = min(16.0, max(3.0, float(np.percentile(border, 95)) * 1.5))
    peak = float(difference.max())
    if peak < _MIN_PEAK_CONTRAST:
        raise ValueError('目标与登记背景颜色过于接近，无法可靠区分前景与背景')
    seed_floor = float(max(background_floor * 2.0, peak * 0.35))

    window = int(max(3, min(9, 2 * max(1, int(round(min(height, width) * 0.02))) + 1)))
    local_max = cv2.dilate(difference, np.ones((window, window), np.uint8))
    # Contrast maxima retain thin strokes. Independent source-color and interior
    # evidence below prevents a varying registered background from erasing cores.
    candidate = difference > max(1.5, background_floor)
    # An opaque foreground can have monotone |F-B| on a gradient background.
    # Source-color platforms provide independent evidence; deep cores retain
    # textured interior colors instead of diffusing a few bright peaks everywhere.
    local_range=np.max(cv2.dilate(source,np.ones((3,3),np.uint8))-cv2.erode(source,np.ones((3,3),np.uint8)),axis=2)
    plateau=local_range<=np.maximum(2.5,difference*.008)
    interior=cv2.distanceTransform(candidate.astype(np.uint8),cv2.DIST_L2,3)>max(12,window*2)
    core = ((difference >= local_max - 0.5)|plateau|interior) & (difference >= seed_floor) & candidate
    if not core.any():
        raise ValueError('未找到可靠的不透明前景核心，无法估计精细蒙版')

    to_core = cv2.distanceTransform((~core).astype(np.uint8), cv2.DIST_L2, 3)
    reach = float(max(8.0, min(28.0, min(height, width) * 0.10)))
    colours = np.zeros_like(source)
    colours[core] = source[core]
    known = core.copy()
    unknown = candidate & ~known & (to_core <= reach)
    if unknown.any():
        kernel = np.ones((3, 3), np.float32)
        for _ in range(int(reach) + 2):
            if not unknown.any():
                break
            counts = cv2.filter2D(known.astype(np.float32), -1, kernel, borderType=cv2.BORDER_CONSTANT)
            reached = unknown & (counts > 0.5)
            if not reached.any():
                break
            for channel in range(3):
                totals = cv2.filter2D(colours[:, :, channel] * known, -1, kernel, borderType=cv2.BORDER_CONSTANT)
                colours[:, :, channel] = np.where(reached, totals / np.maximum(counts, 1.0), colours[:, :, channel])
            known |= reached
            unknown &= ~reached

    usable = known & candidate
    delta = colours - base
    contrast = np.einsum('ijk,ijk->ij', delta, delta)
    observed = source - base
    projection = np.einsum('ijk,ijk->ij', observed, delta) / np.maximum(contrast, 1e-6)
    alpha = np.zeros((height, width), np.float32)
    alpha[usable] = np.clip(projection[usable], 0.0, 1.0)
    # A colour too close to the background cannot be unmixed; skip that edge
    # pixel instead of inventing transparency. Opaque seeds keep alpha = 1.
    weak = contrast < _MIN_UNMIX_CONTRAST * _MIN_UNMIX_CONTRAST
    alpha[usable & ~core & weak] = 0.0
    alpha[alpha < _SOFT_ALPHA] = 0.0

    edge = (alpha > _SOFT_ALPHA) & (alpha < _OPAQUE_ALPHA)
    weight = np.clip((alpha - 0.35) / 0.5, 0.0, 1.0)
    unmixed = np.clip((source - (1.0 - alpha)[:, :, None] * base) / np.maximum(alpha, 0.02)[:, :, None],
                      0.0, 255.0)
    output = source.copy()
    blended = weight[:, :, None] * unmixed + (1.0 - weight)[:, :, None] * colours
    output[edge] = blended[edge]
    rgba = np.ascontiguousarray(np.dstack((
        np.clip(np.rint(output), 0, 255).astype(np.uint8),
        np.clip(np.rint(alpha * 255.0), 0, 255).astype(np.uint8))))

    mask = alpha >= 0.05
    foreground_pixels = int(np.count_nonzero(mask))
    if foreground_pixels == 0:
        raise ValueError('精细蒙版没有可分离前景')
    coverage = float(mask.mean())
    border_mask = np.concatenate((mask[0], mask[-1], mask[:, 0], mask[:, -1]))
    border_coverage = float(border_mask.mean())
    edge_pixels = int(np.count_nonzero(edge))
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if count > 1 and not uniform_matte:
        areas = stats[1:, cv2.CC_STAT_AREA]
        largest = 1 + int(np.argmax(areas))
        _, _, plate_width, plate_height, plate_area = [int(v) for v in stats[largest]]
        # A broad, tall plateau is a page/background block, not a stroke target.
        # An explicit uniform-matte caller already verified the matte, so a
        # rectangular subject filling most of the crop stays acceptable there.
        if plate_area >= height * width * 0.45 and plate_width >= width * 0.85 and plate_height >= height * 0.55:
            raise ValueError('目标区域内出现大面积背景块，已放弃精细蒙版')
    coverage_limit = 0.80 if artistic else 0.78
    border_limit = 0.45 if artistic else 0.24
    minimum = 0.0015 if artistic else 0.002
    if coverage < minimum or coverage > coverage_limit or border_coverage > border_limit:
        raise ValueError('精细蒙版前景占比或边界覆盖不可靠，已保留原页面')

    border_reliability = float(np.clip(
        1.0 - max(border_median / 26.0, border_mad / 14.0, border_changed / 0.22), 0.0, 1.0))
    contrast_reliability = float(np.clip((peak - _MIN_PEAK_CONTRAST) / 120.0, 0.0, 1.0))
    soft = edge & usable & (alpha > 0.05) & (alpha < 0.95)
    edge_residual = 0.0
    if np.any(soft):
        reconstructed = alpha[:, :, None] * colours + (1.0 - alpha[:, :, None]) * base
        residual = np.linalg.norm(source - reconstructed, axis=2)[soft]
        relative = residual / np.maximum(np.linalg.norm(delta, axis=2)[soft], 1.0)
        edge_residual = float(np.median(relative))
        unmix_fit = float(np.clip(1.0 - edge_residual * 4.0, 0.0, 1.0))
    else:
        unmix_fit = 0.7
    confidence = float(np.clip(0.38 * border_reliability + 0.34 * contrast_reliability + 0.28 * unmix_fit,
                               0.0, 1.0))
    if confidence < 0.35:
        raise ValueError('精细蒙版置信度过低（前景与背景过于接近），已跳过')

    report = {
        'mode': MODE,
        'coverage': round(coverage, 6),
        'threshold': round(seed_floor, 3),
        'borderDifference': round(border_median, 3),
        'edgePixels': edge_pixels,
        'unmixing': True,
        'confidence': round(confidence, 4),
        'softCoverage': round(float(alpha.mean()), 6),
        'borderCoverage': round(border_coverage, 6),
        'foregroundPixels': foreground_pixels,
        'backgroundFloor': round(background_floor, 3),
        'peakDifference': round(peak, 3),
        'opaqueSeeds': int(np.count_nonzero(core)),
        'edgeResidual': round(edge_residual, 4),
        'canvasWidth': int(width),
        'canvasHeight': int(height),
        'artistic': bool(artistic),
        'uniformMatte': bool(uniform_matte),
    }
    return rgba, report
