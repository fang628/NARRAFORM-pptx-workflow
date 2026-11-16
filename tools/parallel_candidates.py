"""Construct shared-slope quads from either measured side, never their mean."""
import numpy as np


def measured_parallel_candidates(points):
    points = np.asarray(points, float)
    top, bottom = points[0, 1], points[3, 1]
    centers = (points[:2, 0] + points[[3, 2], 0]) / 2
    for shift in (points[3, 0] - points[0, 0], points[2, 0] - points[1, 0]):
        yield np.array([[centers[0] - shift / 2, top], [centers[1] - shift / 2, top],
                        [centers[1] + shift / 2, bottom], [centers[0] + shift / 2, bottom]])


def parallel_side_hypotheses(points):
    points = np.asarray(points, float)
    if points.shape != (4, 2) or not np.isfinite(points).all():
        return []
    # Keep genuinely tilted caps and trapezoids in their own shape families.
    if max(abs(points[0, 1] - points[1, 1]), abs(points[2, 1] - points[3, 1])) > 2:
        return []
    dl, dr = points[3, 0] - points[0, 0], points[2, 0] - points[1, 0]
    if dl * dr <= 0 or abs(dl - dr) > max(5, .4 * max(abs(dl), abs(dr))):
        return []
    return list(measured_parallel_candidates(points))
