"""Foreground support for borderless fills, independent of fit residual."""
import numpy as np


def has_visible_border(element):
    return (float(element.get('strokeWidth') or 0) > 0
            and float(element.get('opacity', 1)) * float(element.get('colorOpacity', 1)) > .01)


def unsupported_borderless_fill(element, pixels, background):
    if has_visible_border(element) or background is None:
        return False
    observed = np.asarray(pixels, float).reshape(-1, 3)
    lower = np.asarray(background, float).reshape(-1, 3)
    if len(observed) < 6 or observed.shape != lower.shape:
        return False
    delta = np.max(abs(observed - lower), axis=1)
    # Small antialias/compression differences cannot establish a foreground.
    return bool(np.median(delta) <= 8 and (delta <= 12).mean() >= .90)
