#!/usr/bin/env python
"""S3 row-band detection and colour consensus for table objects (05-B / 05-E).

One process detects ALL table grids of a page, so S3 does not fork a tool per table.

Spec JSON:
{
  "reference": "<preview png>", "background": "<wordless background png>|null",
  "scene": {"width": 1600, "height": 900},
  "options": {"colorTolerance": 9, "sampleInset": 0.12, "gradientMinR2": 0.6,
              "gradientMinDeltaE": 8},
  "tables": [{
    "tableId": "table-1",
    "outer": {"x": 119, "y": 333, "w": 1365, "h": 444, "source": "frame-element"},
    "rows": [{"rowIndex": 0, "kind": "header", "y": 346, "bottom": 417,
              "contentTop": 358, "contentBottom": 404}],
    "columns": [{"columnIndex": 0, "x": 252, "right": 452}],
    "cells": [{"row": 0, "column": 0, "x": 260, "y": 358, "w": 160, "h": 46}],
    "exclude": [{"x": 260, "y": 358, "w": 160, "h": 46, "kind": "text"}]
  }]
}

Output JSON:
{
  "status": "available",
  "tables": [{
    "tableId": "table-1", "status": "ok|partial", "issues": [],
    "grid": {"boundaries": [346, 417, ...], "verticalBoundaries": [252, ...],
             "confidence": 0.0..1.0, "source": "cells+colour-steps"},
    "rows": [{"rowIndex": 0, "kind": "header", "fill": "003266",
              "gradient": {"type": "linear", "angle": 90,
                           "stops": [{"position": 0, "color": "003266", "opacity": 1}, ...]}|null,
              "colorGroup": "table-1:g0", "confidence": 0.8, "coverage": 0.9,
              "samples": 232, "reliable": true, "error": 2.1,
              "gradientEvidence": {"r2": 0.71, "deltaE": 12.3, "axis": "y"}}],
    "colorGroups": [{"id": "table-1:g0", "fill": "0A2B4A", "gradient": null,
                     "rows": [1, 2, 3], "representativeRow": 2, "size": 3,
                     "confidence": 0.8, "error": 1.4}],
    "diagnostics": {"validPixels": 12345, "elapsedMs": 12.3}
  }],
  "diagnostics": {"engine": "table_rows.py", "version": 1, "elapsedMs": 25.0}
}

Rules enforced here, not in the caller:
  * only foreground occluders hide pixels. Text/formula entries in spec.exclude are GLYPH ZONES: a
    local high-frequency/deviation mask removes the glyph ink and keeps the band colour between
    glyphs (a whole text box would eat a dense header/row). Icons/images/lines stay tight hard boxes.
    Ancestor/enclosing panels and other lower-layer carriers must not be sent at all (the caller skips
    them); the wordless-background difference is never used as a mask because it contains the real
    header/row band colours;
  * each row reports `reliable` only when it has enough valid pixels, enough sample bins and a real
    confidence; a row without evidence keeps fill=null and is never merged into a colour group;
  * a row keeps a *solid* fill unless a directional gradient has real evidence (R2 and end-to-end
    deltaE gates) - no gradient is invented by default; a gradient row's error/confidence is its
    residual error, not the solid-model error;
  * rows are grouped by measured colour distance (LAB) only: header rows are grouped separately,
    alternating groups stay separate when they actually differ, and an outlier/emphasis row keeps its
    own group. Colours inside one group share the robust medoid representative;
  * when the grid cannot be verified the caller keeps the original geometry (this tool then reports
    a lower confidence and status=partial).
"""
import json
import sys
import time

import cv2
import numpy as np
from parameter_confidence import weighted_median
from PIL import Image
from paint_models import fit_native_paint

SCENE = (1600, 900)
DEFAULT_OPTIONS = {"colorTolerance": 9.0, "sampleInset": 0.12,
                   "gradientMinR2": 0.6, "gradientMinDeltaE": 8.0,
                   "minRowCoverage": 0.03, "minRowConfidence": 0.2}


def load_image(path, size):
    with Image.open(path) as source:
        source.load()
        return np.asarray(source.convert("RGB").resize(size, Image.Resampling.LANCZOS))


def to_lab(rgb):
    array = np.asarray(rgb, dtype=np.float32).reshape(1, 1, 3) / 255.0
    return cv2.cvtColor(array, cv2.COLOR_RGB2LAB)[0, 0]


def lab_distance(first, second):
    return float(np.linalg.norm(np.asarray(first, np.float32) - np.asarray(second, np.float32)))


def hex_color(rgb):
    values = np.clip(np.rint(np.asarray(rgb, np.float32)), 0, 255).astype(np.uint8)
    return "%02X%02X%02X" % (int(values[0]), int(values[1]), int(values[2]))


def pixel_box(box, scene):
    try:
        x, y, w, h = (float(box.get(key, 0) or 0) for key in ("x", "y", "w", "h"))
    except (TypeError, ValueError, AttributeError):
        return None
    left, top = int(round(x)), int(round(y))
    right, bottom = int(round(x + w)), int(round(y + h))
    left, top = max(0, left), max(0, top)
    right, bottom = min(scene[0], right), min(scene[1], bottom)
    if right - left < 2 or bottom - top < 2:
        return None
    return left, top, right, bottom


def glyph_zone_mask(image, zones, options):
    """Glyph-ink pixels inside known text zones; the band colour between glyphs is preserved.

    A whole text box cannot be excluded: dense CJK header/row text covers most of the band, so
    dropping the full box leaves (almost) no pixels to measure. Inside a text zone the band is
    smooth, while glyph strokes are local high-frequency deviations -> keep the low-frequency
    background and remove only the ink.
    """
    if not zones:
        return None
    if min(image.shape[:2]) < 8:
        return None
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    blur = int(options.get("glyphBlur", 15))
    if blur % 2 == 0:
        blur += 1
    blur = max(3, min(blur, max(3, (min(gray.shape[:2]) // 2) * 2 - 1)))
    smoothed = cv2.medianBlur(gray, blur)
    deviation = cv2.absdiff(gray, smoothed)
    gradient = cv2.magnitude(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3),
                             cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    mask = np.zeros(gray.shape, np.uint8)
    for x0, y0, x1, y1 in zones:
        patch_deviation = deviation[y0:y1, x0:x1]
        patch_gradient = gradient[y0:y1, x0:x1]
        if patch_deviation.size == 0:
            continue
        deviation_threshold = max(float(options.get("glyphDeviation", 16.0)),
                                  float(np.percentile(patch_deviation, 65)) * 1.6)
        gradient_threshold = max(float(options.get("glyphGradient", 30.0)),
                                 float(np.percentile(patch_gradient, 80)) * 1.5)
        ink = (patch_deviation > deviation_threshold) | (patch_gradient > gradient_threshold)
        mask[y0:y1, x0:x1] = ink.astype(np.uint8) * 255
    return cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)


def straight_vertical_lines(image):
    """x centres of long vertical straight lines (table column separators), robust to glyph zones.

    The glyph mask removes text ink together with 1px separators inside a text box; a morphological
    vertical opening keeps only structures that run for ~half the table height, so real separators
    are recovered from the raw image instead of from a text-masked colour profile.
    """
    if min(image.shape[:2]) < 16:
        return []
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 15, 45)
    for channel in cv2.split(image):edges=np.maximum(edges,cv2.Canny(channel,15,45))
    kernel_height = max(12, int(round(image.shape[0] * 0.45)))
    opened = cv2.morphologyEx(edges, cv2.MORPH_OPEN, np.ones((kernel_height, 1), np.uint8))
    column_strength = (opened > 0).sum(axis=0)
    xs = np.flatnonzero(column_strength >= max(6, int(kernel_height * 0.7)))
    rgb=image.astype(float)
    if image.shape[1]>8:
        ridge=np.linalg.norm(rgb[:,3:-3]-(rgb[:,:-6]+rgb[:,6:])/2,axis=2)
        supported=np.flatnonzero(np.mean(ridge>18,axis=0)>.5)+3
        xs=np.unique(np.concatenate([xs,supported]))
    clusters = []
    for value in xs:
        value = int(value)
        if clusters and value - clusters[-1][-1] <= 4:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [float(np.mean(cluster)) for cluster in clusters]


def measure_alignment(image,cells,rows,boundaries,vertical,options):
    observations=[]
    if len(vertical)<2:return observations
    ordered=sorted(rows,key=lambda r:r['y']);slots={int(r['rowIndex']):i for i,r in enumerate(ordered)}
    for cell in cells:
        row=int(cell.get('row',-1));column=int(cell.get('column',-1));i=slots.get(row)
        if i is None or not 0<=column<len(vertical)-1:continue
        left,right=vertical[column:column+2];top,bottom=boundaries[i:i+2]
        x0,x1=max(0,round(left+5)),min(image.shape[1],round(right-5));y0,y1=max(0,round(top+4)),min(image.shape[0],round(bottom-4))
        patch=image[y0:y1,x0:x1]
        if min(patch.shape[:2],default=0)<6:continue
        bg=np.median(patch.reshape(-1,3),axis=0)
        ink=(np.linalg.norm(patch.astype(float)-bg,axis=2)>45).astype(np.uint8)
        count,labels,stats,centers=cv2.connectedComponentsWithStats(ink);parts=[]
        for k in range(1,count):
            x,y,w,h,area=stats[k]
            if area>=4 and 3<=h<=patch.shape[0]*.95 and w<patch.shape[1]*.9:parts.append((x,y,w,h,area))
        if len(parts)<2:continue
        ink_left=int(x0+min(p[0] for p in parts));ink_right=int(x0+max(p[0]+p[2] for p in parts))
        ink_top=int(y0+min(p[1] for p in parts));ink_bottom=int(y0+max(p[1]+p[3] for p in parts))
        if ink_right-ink_left>(right-left)*.9:continue
        observations.append({'key':cell.get('key'),'row':row,'column':column,'kind':ordered[i].get('kind','data'),
            'inkLeft':ink_left,'inkRight':ink_right,'inkTop':ink_top,'inkBottom':ink_bottom,'left':left,'right':right,'top':top,'bottom':bottom,
            'confidence':round(min(.95,.6+len(parts)*.015),3),'independent':True})
    for kind in ('header','data'):
        for column in sorted({o['column'] for o in observations}):
            peers=[o for o in observations if o['kind']==kind and o['column']==column]
            if not peers:continue
            weights=[o['confidence'] for o in peers]
            offsets={'left':[o['inkLeft']-o['left'] for o in peers],
                'center':[(o['inkLeft']+o['inkRight']-o['left']-o['right'])/2 for o in peers],
                'right':[o['right']-o['inkRight'] for o in peers]}
            medians={a:weighted_median(v,weights) for a,v in offsets.items()}
            errors={a:float(np.average(np.abs(np.asarray(v)-medians[a]),weights=weights)) for a,v in offsets.items()}
            # A centred header can be identified from one row; a left/right
            # column needs several text lengths agreeing on the same anchor.
            errors['center']+=abs(medians['center'])*.35
            if len(peers)==1:
                mode='center' if abs(medians['center'])<=max(6,(peers[0]['right']-peers[0]['left'])*.035) else 'left' if medians['left']<medians['right'] else 'right'
            else:mode=min(errors,key=errors.get)
            width=peers[0]['right']-peers[0]['left']
            if mode!='center' and medians[mode]>width*.2:
                if abs(medians['center'])<=max(8,width*.04):mode='center'
                else:continue
            for o in peers:
                o.update(align=mode,centerOffset=round(medians['center'],2) if mode=='center' else 0,inset=round(max(4,medians[mode]),1) if mode!='center' else 4,
                         sourceKeys=[p['key'] for p in peers],confidence=round(min(weights),3))
    return observations


def colour_profile(image, mask, left, right, top, bottom):
    """Median colour per pixel row/column of the valid strip."""
    if right - left < 2 or bottom - top < 2:
        return np.zeros((bottom - top, 3), np.float32)
    strip = image[top:bottom, left:right].astype(np.float32)
    valid = mask[top:bottom, left:right] > 0
    profile = np.zeros((bottom - top, 3), np.float32)
    count = np.zeros(bottom - top, np.float32)
    for offset in range(bottom - top):
        pixels = strip[offset][valid[offset]]
        if pixels.size:
            profile[offset] = np.median(pixels, axis=0)
            count[offset] = pixels.shape[0]
    valid_rows = count >= 8
    if valid_rows.sum() >= 2:
        known = np.flatnonzero(valid_rows)
        for channel in range(3):
            profile[:, channel] = np.interp(np.arange(profile.shape[0]), known,
                                            profile[known, channel])
    return profile


def snap_boundaries(image, mask, region, candidates, window, axis):
    """Refine row/column boundaries with the strongest colour step inside a small window.

    `window` is either one width for all internal boundaries or a per-boundary list (a 3-column table
    may have very different cell gaps, and the vertical profile walk must stay on the same axis as
    the boundary it refines).
    """
    left, top, right, bottom = region
    windows = list(window) if isinstance(window, (list, tuple)) else None
    usable = [index for index in range(1, len(candidates) - 1)
              if 0 <= candidates[index] <= (bottom if axis == "y" else right)]
    snapped = list(candidates)
    confidences = [0.5 if index in (0, len(candidates) - 1) else None
                   for index in range(len(candidates))]
    steps = []
    profiles = {}
    for index in usable:
        current_window = int(windows[index]) if windows and index < len(windows) \
            else (int(windows[0]) if windows else int(window))
        value = int(round(candidates[index]))
        if axis == "y":
            low, high = max(top, value - current_window), min(bottom, value + current_window + 1)
            profile = colour_profile(image, mask, left, right, low, high)
            differences = np.linalg.norm(np.diff(profile, axis=0), axis=1)
            offset = low
        else:
            low, high = max(left, value - current_window), min(right, value + current_window + 1)
            # Transposed image: rows are x, columns are y. Keep the walk on x by passing the y span
            # as the strip width and the x window as the strip height (previously the window was
            # transposed, so every vertical boundary snapped to the same end of the garbage strip).
            profile = colour_profile(np.transpose(image, (1, 0, 2)), np.transpose(mask),
                                     top, bottom, low, high)
            differences = np.linalg.norm(np.diff(profile, axis=0), axis=1)
            offset = low
        if differences.size < 2:
            continue
        profiles[index] = float(np.median(differences))
        steps.append(float(np.max(differences)))
        best = int(np.argmax(differences))
        noise = profiles[index] + 1e-3
        strength = float(differences[best]) / noise
        confidence = float(np.clip((strength - 1.0) / 4.0, 0.0, 1.0))
        snapped[index] = offset + best + 0.5
        confidences[index] = round(confidence, 4)
    values = [value for value in confidences if value is not None]
    confidence = float(np.mean(values)) if values else 0.0
    if profiles:
        confidence = float(np.clip(0.25 * confidence + 0.75 * float(np.mean(
            [min(1.0, value / 3.0) for value in steps])), 0.0, 1.0))
    return snapped, round(confidence, 4)


def sample_grid(image, mask, region, y_bins, x_bins):
    left, top, right, bottom = region
    if right - left < 4 or bottom - top < 2:
        return [], 0, 0
    height = bottom - top
    width = right - left
    bins = []
    for y_index in range(y_bins):
        y0 = top + int(round(height * y_index / y_bins))
        y1 = top + int(round(height * (y_index + 1) / y_bins))
        for x_index in range(x_bins):
            x0 = left + int(round(width * x_index / x_bins))
            x1 = left + int(round(width * (x_index + 1) / x_bins))
            if x1 - x0 < 2 or y1 - y0 < 1:
                continue
            patch = image[y0:y1, x0:x1].astype(np.float32)
            valid = mask[y0:y1, x0:x1] > 0
            pixels = patch[valid]
            if pixels.shape[0] < 6:
                continue
            # High-frequency outlier trim only (glyph edges / antialiasing not covered by an exclude
            # box). A flat low-frequency row colour survives untouched: this never removes the row
            # band colour itself.
            median = np.median(pixels, axis=0)
            distance = np.linalg.norm(pixels - median, axis=1)
            core = pixels[distance <= max(24.0, float(np.percentile(distance, 70)))]
            colour = np.median(core, axis=0) if core.shape[0] >= max(4, pixels.shape[0] * 0.3) \
                else median
            bins.append({"x": (x_index + 0.5) / x_bins, "y": (y_index + 0.5) / y_bins,
                         "colour": colour, "count": int(pixels.shape[0])})
    area = max(1, (right - left) * (bottom - top))
    valid_pixels = int((mask[top:bottom, left:right] > 0).sum())
    coverage = float(valid_pixels) / float(area)
    return bins, valid_pixels, coverage


def fit_axis(bins, axis):
    """Least-squares colour ramp along one axis with an R2 and an end-to-end deltaE."""
    if len(bins) < 4:
        return None
    t = np.asarray([item[axis] for item in bins], np.float32)
    colours = np.asarray([to_lab(item["colour"]) for item in bins], np.float32)
    design = np.stack([np.ones_like(t), t], axis=1)
    coefficients, *_ = np.linalg.lstsq(design, colours, rcond=None)
    predicted = design @ coefficients
    residual = colours - predicted
    variance = colours - colours.mean(axis=0, keepdims=True)
    total = float((variance ** 2).sum()) + 1e-6
    r2 = float(1.0 - (residual ** 2).sum() / total)
    start = coefficients[0]
    end = coefficients[0] + coefficients[1]
    delta_e = lab_distance(start, end)
    mean_error = float(np.linalg.norm(residual, axis=1).mean())
    return {"r2": float(np.clip(r2, 0.0, 1.0)), "deltaE": float(delta_e),
            "meanError": mean_error, "axis": axis,
            "start": start, "end": end}


def robust_colour_bins(bins):
    """Drop a minority of colour-outlier bins (frame glow, edge bloom) from the row evidence."""
    if not bins:
        return []
    colours = np.asarray([item["colour"] for item in bins], np.float32)
    median = np.median(colours, axis=0)
    distance = np.linalg.norm(colours - median, axis=1)
    mad = float(np.median(distance)) + 1e-6
    keep = distance <= max(8.0, 3.0 * mad)
    if int(keep.sum()) >= max(6, int(len(bins) * 0.5)):
        return [item for item, ok in zip(bins, keep) if ok]
    return bins


def row_paint(bins, options):
    if not bins:
        return {"fill": None, "gradient": None, "error": None, "solidError": None,
                "gradientEvidence": None}
    filtered = robust_colour_bins(bins)
    colours = np.asarray([item["colour"] for item in filtered], np.float32)
    representative = np.median(colours, axis=0)
    solid_error = float(np.linalg.norm(colours - representative, axis=1).mean())
    gradient = None
    evidence = None
    best = None
    for axis in ("x", "y"):
        fit = fit_axis(filtered, axis)
        if not fit:
            continue
        # A more complex model must clearly beat the solid representation.
        if fit["r2"] >= options["gradientMinR2"] \
                and fit["deltaE"] >= options["gradientMinDeltaE"] \
                and fit["meanError"] <= max(1.5, solid_error * 0.7):
            if not best or fit["r2"] * fit["deltaE"] > best["r2"] * best["deltaE"]:
                best = fit
    if best:
        start_rgb = cv2.cvtColor(np.asarray(best["start"], np.float32).reshape(1, 1, 3),
                                 cv2.COLOR_LAB2RGB)[0, 0] * 255.0
        end_rgb = cv2.cvtColor(np.asarray(best["end"], np.float32).reshape(1, 1, 3),
                               cv2.COLOR_LAB2RGB)[0, 0] * 255.0
        gradient = {"type": "linear", "angle": 90 if best["axis"] == "y" else 0,
                    "stops": [{"position": 0, "color": hex_color(start_rgb), "opacity": 1},
                              {"position": 1, "color": hex_color(end_rgb), "opacity": 1}]}
        evidence = {"r2": round(best["r2"], 4), "deltaE": round(best["deltaE"], 2),
                    "axis": best["axis"], "meanError": round(best["meanError"], 3),
                    "solidError": round(solid_error, 3)}
        # The measurement error of a gradient row is its residual error, not the solid-model error:
        # anything else would report a correct gradient row as low-confidence.
        error = max(0.5, float(best["meanError"]))
    else:
        error = solid_error
    fill = gradient["stops"][0]["color"] if gradient else hex_color(representative)
    return {"fill": fill, "gradient": gradient, "error": round(error, 3),
            "solidError": round(solid_error, 3), "gradientEvidence": evidence}


def cluster_rows(rows, tolerance, table_id):
    """Group *measured* data rows by LAB distance; header rows are grouped separately.

    A row without reliable colour evidence is never merged into a group and never becomes a
    representative: groups describe measured rows only.
    """
    groups = []
    reliable = [r for r in rows if r['kind'] != 'header' and r.get('fill') and r.get('reliable', True) and float(r.get('confidence',.6))>=.55 and not r.get('gradient')]
    alternating = False
    if len(reliable) >= 4:
        bands = [[r for r in reliable if r['rowIndex'] % 2 == parity] for parity in (0, 1)]
        if all(len(band) >= 2 for band in bands):
            values = [np.asarray([to_lab(np.array([int(r['fill'][i:i+2], 16) for i in (0,2,4)])) for r in band]) for band in bands]
            centers = [np.median(v, axis=0) for v in values]
            noise = max(float(np.median([lab_distance(v, center) for v in group])) for group, center in zip(values, centers))
            alternating = lab_distance(*centers) > max(2.0, noise * 3)
    for row in sorted(rows,key=lambda r:-float(r.get('confidence',.6))):
        if row["kind"] == "header" or not row.get("fill") or not row.get("reliable", True):
            continue
        lab = to_lab(np.array([int(row["fill"][index:index + 2], 16) for index in (0, 2, 4)]))
        gradient = row.get("gradient")
        target = None
        for group in groups:
            if alternating and not gradient and row['rowIndex'] % 2 != group['members'][0]['rowIndex'] % 2:
                continue
            if (gradient is None) != (group["gradient"] is None):
                continue
            if gradient and group["gradient"]:
                angle_delta = abs((gradient["angle"] or 0) - (group["gradient"]["angle"] or 0))
                if min(angle_delta, 360 - angle_delta) > 20:
                    continue
                distance = max(lab_distance(to_lab(np.array(
                    [int(stop["color"][index:index + 2], 16) for index in (0, 2, 4)])),
                    to_lab(np.array([int(other["color"][index:index + 2], 16)
                                     for index in (0, 2, 4)])))
                    for stop, other in zip(gradient["stops"], group["gradient"]["stops"]))
            else:
                distance = lab_distance(lab, group["centroid"])
            if distance <= tolerance:
                target = group
                break
        if target is None:
            groups.append({"members": [row], "centroid": lab, "gradient": gradient})
        else:
            target["members"].append(row)
            sources=[member for member in target['members'] if float(member.get('confidence',.6))>=.55]
            values=np.asarray(
                [to_lab(np.array([int(member["fill"][index:index + 2], 16)
                                  for index in (0, 2, 4)])) for member in sources],np.float32)
            if sources:target['centroid']=np.array([weighted_median(values[:,i],[float(member.get('confidence',.6)) for member in sources]) for i in range(3)])
    result = []
    for number, group in enumerate(groups):
        members = group["members"]
        best_member = members[0]
        best_total = None
        sources=[member for member in members if float(member.get('confidence',.6))>=.55]
        if not sources:continue
        for member in sources:
            member_lab = to_lab(np.array([int(member["fill"][index:index + 2], 16)
                                          for index in (0, 2, 4)]))
            total = sum(float(other.get('confidence',.6))*lab_distance(member_lab, to_lab(np.array(
                [int(other["fill"][index:index + 2], 16) for index in (0, 2, 4)])))
                for other in sources)
            if best_total is None or total < best_total:
                best_total = total
                best_member = member
        result.append({"id": "%s:g%d" % (table_id, number),
                       "fill": best_member["fill"],
                       "gradient": best_member.get("gradient"),
                       "rows": sorted(member["rowIndex"] for member in members),
                       "representativeRow": best_member["rowIndex"],
                       "size": len(members),
                       "error": round(float(best_total or 0.0) / max(1, len(members)), 3),
                       "confidence": round(float(np.clip(
                           1.0 - (best_total or 0.0) / max(1, len(members)) / 40.0, 0.2, 0.95)), 4)})
        for member in members:
            member["colorGroup"] = result[-1]["id"]
    header_rows = [row for row in rows if row["kind"] == "header"
                   and row.get("fill") and row.get("reliable", True) and float(row.get('confidence',.6))>=.55]
    if header_rows:
        representative = max(header_rows, key=lambda row: float(row.get("confidence") or 0.0))
        result.append({"id": "%s:header" % table_id, "fill": representative["fill"],
                       "gradient": representative.get("gradient"),
                       "rows": [row["rowIndex"] for row in header_rows],
                       "representativeRow": representative["rowIndex"],
                       "size": len(header_rows),
                       "error": round(float(np.mean(
                           [float(row.get("error") or 0.0) for row in header_rows])), 3),
                       "confidence": round(float(np.mean(
                           [float(row.get("confidence") or 0.0) for row in header_rows])), 4)})
        for row in header_rows:
            row["colorGroup"] = result[-1]["id"]
    return result


def measured_outer(table,reference):
    """Measure four actual rim ridges near the declared frame, before row locks."""
    outer=table.get('outer') or {}
    if not all(k in outer for k in ('x','y','w','h')):return None
    x,y,w,h=[float(outer[k]) for k in ('x','y','w','h')]
    if w<60 or h<40:return None
    gray=cv2.cvtColor(reference,cv2.COLOR_RGB2GRAY).astype(float)
    found=[];supports=[]
    for axis,edge in [('y',y),('y',y+h),('x',x),('x',x+w)]:
        extent=h if axis=='y' else w
        radius=min(32,max(8,extent*.12))
        choices=[]
        for at in range(max(2,round(edge-radius)),min(gray.shape[0 if axis=='y' else 1]-2,round(edge+radius)+1)):
            positions=np.linspace(x+w*.12,x+w*.88,180).astype(int) if axis=='y' else np.linspace(y+h*.12,y+h*.88,120).astype(int)
            positions=np.clip(positions,1,gray.shape[1 if axis=='y' else 0]-2)
            center=gray[at,positions] if axis=='y' else gray[positions,at]
            a=gray[at-2,positions] if axis=='y' else gray[positions,at-2]
            b=gray[at+2,positions] if axis=='y' else gray[positions,at+2]
            ridge=center-np.maximum(a,b)
            support=float((ridge>3).mean());strength=float(np.median(ridge))
            if support>=.6 and strength>3:choices.append((strength/(1+abs(at-edge)*.025),at,support))
        if not choices:return None
        _,at,support=max(choices);found.append(at);supports.append(support)
    top,bottom,left,right=found
    if right-left<w*.7 or bottom-top<h*.65:return None
    for cell in table.get('cells') or []:
        cx=cell.get('x',0)+cell.get('w',0)/2;cy=cell.get('y',0)+cell.get('h',0)/2
        if not left<=cx<=right or not top<=cy<=bottom:return None
    return {'x':left,'y':top,'w':right-left,'h':bottom-top,'right':right,'bottom':bottom,
            'confidence':round(min(supports),3),'source':'measured-frame-ridges'}


def measure_table(table, reference, mask, options, scene):
    started = time.perf_counter()
    table_id = str(table.get("tableId") or "")
    issues = []
    rows = sorted([row for row in table.get("rows") or []
                   if isinstance(row, dict) and row.get("bottom", 0) > row.get("y", 0)],
                  key=lambda row: float(row.get("y", 0)))
    if not rows:
        return {"tableId": table_id, "status": "partial", "issues": ["no-row-slots"],
                "grid": {"boundaries": [], "verticalBoundaries": [], "confidence": 0.0,
                         "source": "cell-constraints"},
                "rows": [], "colorGroups": [], "diagnostics": {"elapsedMs": 0.0}}
    cells = [cell for cell in table.get("cells") or [] if isinstance(cell, dict)]
    frame=measured_outer(table,reference)
    outer = frame or table.get("outer") or {}
    if not pixel_box(outer, scene) and cells:
        xs = [float(cell.get("x", 0)) for cell in cells]
        ys = [float(cell.get("y", 0)) for cell in cells]
        rights = [float(cell.get("x", 0)) + float(cell.get("w", 0)) for cell in cells]
        bottoms = [float(cell.get("y", 0)) + float(cell.get("h", 0)) for cell in cells]
        outer = {"x": min(xs), "y": min(ys), "w": max(rights) - min(xs),
                 "h": max(bottoms) - min(ys)}
    outer_box = pixel_box(outer, scene)
    if not outer_box:
        return {"tableId": table_id, "status": "partial", "issues": ["no-outer"],
                "grid": {"boundaries": [], "verticalBoundaries": [], "confidence": 0.0,
                         "source": "cell-constraints"},
                "rows": [], "colorGroups": [], "diagnostics": {"elapsedMs": 0.0}}
    left, top, right, bottom = outer_box
    # All measurement happens on the table crop so image/mask/exclude coordinates stay local.
    local_image = reference[top:bottom, left:right]
    table_mask = mask[top:bottom, left:right].copy()
    # Inner margin: never sample the frame stroke or its glow.
    margin = 2
    if table_mask.shape[0] > 2 * margin + 2 and table_mask.shape[1] > 2 * margin + 2:
        table_mask[:margin, :] = 0
        table_mask[-margin:, :] = 0
        table_mask[:, :margin] = 0
        table_mask[:, -margin:] = 0
    text_zones = []
    for box in table.get("exclude") or []:
        pixel = pixel_box(box, scene)
        if not pixel:
            continue
        kind = str(box.get("kind") or "")
        x0, y0, x1, y1 = pixel
        if kind == "text":
            # Text is a glyph zone, not a hole: only its ink is removed below, so the band colour
            # between glyphs (dense CJK text covers most of a header/row) stays measurable.
            local = (max(0, x0 - left), max(0, y0 - top),
                     min(right - left, x1 - left), min(bottom - top, y1 - top))
            if local[2] - local[0] >= 2 and local[3] - local[1] >= 2:
                text_zones.append(local)
            continue
        pad = 1 if kind == "grid" else 2
        table_mask[max(0, y0 - top - pad):max(0, y1 - top + pad),
                   max(0, x0 - left - pad):max(0, x1 - left + pad)] = 0
    if text_zones:
        glyphs = glyph_zone_mask(local_image, text_zones, options)
        if glyphs is not None:
            table_mask = np.where(glyphs > 0, 0, table_mask).astype(np.uint8)
    # Text / icon / grid coverage is removed through spec.exclude boxes only. The wordless-background
    # difference is NOT used as a mask: it contains the true (low-frequency) header/row band colours,
    # so masking every changed pixel erased the very rows being measured.
    # Row/column boundary candidates come from the cell constraints; colour steps refine them.
    candidates = [float(rows[0].get("y", top))] + [
        (float(rows[index].get("contentBottom", rows[index].get("bottom"))) * 0.5
         + float(rows[index + 1].get("contentTop", rows[index + 1].get("y"))) * 0.5)
        for index in range(len(rows) - 1)] + [float(rows[-1].get("bottom", bottom))]
    window = int(max(4, min(16, round(np.median([row["bottom"] - row["y"] for row in rows]) * 0.3))))
    boundaries, confidence = snap_boundaries(local_image, table_mask,
                                             (0, 0, right - left, bottom - top),
                                             [value - top for value in candidates], window, "y")
    boundaries = [round(value + top, 1) for value in boundaries]
    # A cell-derived candidate can sit a few px outside the measured table frame (e.g. the header
    # slot top before the frame edge). Clamp the grid to the measured outer box so no sample strip
    # ever reaches the enclosing panel/background above the table.
    boundaries = [min(bottom, max(top, value)) for value in boundaries]
    if frame:
        boundaries[0]=float(top+2)
        boundaries[-1]=float(bottom-2)
    horizontal=straight_vertical_lines(np.transpose(local_image,(1,0,2)))
    internal_y=[top+value for value in horizontal if 5<value<bottom-top-5]
    if len(internal_y)==len(rows)-1:
        boundaries=[float(top+2),*internal_y,float(bottom-2)];confidence=max(confidence,.9)
    for index in range(1, len(boundaries)):
        boundaries[index] = max(boundaries[index], boundaries[index - 1] + 1.0)
    columns = sorted([column for column in table.get("columns") or []
                      if isinstance(column, dict)], key=lambda column: float(column.get("x", 0)))
    if len(columns) >= 2:
        vertical_candidates = [float(columns[0].get("x", left))] + [
            (float(columns[index].get("right", 0)) + float(columns[index + 1].get("x", 0))) * 0.5
            for index in range(len(columns) - 1)] + [float(columns[-1].get("right", right))]
        vertical_window = int(max(4, min(16, round(
            np.median([column["right"] - column["x"] for column in columns]) * 0.2))))
        # Per-boundary search width: a real divider can sit in a wide cell gap (p10) or a few px
        # inside a text box (p11 col2 at 424 vs cell-box boundary 403), so the window follows the
        # actual gap and cell width instead of one fixed number.
        median_column_width = float(np.median(
            [max(1.0, float(column.get("right", 0)) - float(column.get("x", 0)))
             for column in columns]))
        vertical_windows = []
        for index in range(len(vertical_candidates)):
            if index == 0 or index == len(vertical_candidates) - 1:
                vertical_windows.append(vertical_window)
                continue
            gap = max(0.0, float(columns[index].get("x", 0))
                      - float(columns[index - 1].get("right", 0)))
            vertical_windows.append(int(max(8, min(32, round(
                max(gap * 0.6, median_column_width * 0.25))))))
        vertical_boundaries, vertical_confidence = snap_boundaries(
            local_image, table_mask, (0, 0, right - left, bottom - top),
            [value - left for value in vertical_candidates], vertical_windows, "x")
        vertical_boundaries = [round(value + left, 1) for value in vertical_boundaries]
        # Long vertical structures found in the raw image are stronger evidence than a colour profile
        # through text zones; use them when they are close to the expected cell boundary.
        line_centres = straight_vertical_lines(local_image)
        internal=[left+c for c in line_centres if 8<c<right-left-8]
        if len(internal)==len(columns)-1:
            vertical_boundaries=[float(left),*internal,float(right)];vertical_confidence=.9
            vertical_windows=[0]*len(vertical_candidates)
        if line_centres:
            overridden = 0
            for index in range(1, len(vertical_candidates) - 1):
                expected = float(vertical_candidates[index])
                nearest = min(((abs(left + centre + 0.5 - expected), left + centre + 0.5)
                               for centre in line_centres), key=lambda item: item[0])
                if nearest[0] <= vertical_windows[index] + 12:
                    vertical_boundaries[index] = round(nearest[1], 1)
                    overridden += 1
            if overridden:
                vertical_confidence = max(vertical_confidence, 0.7)
        vertical_boundaries = [min(right, max(left, value)) for value in vertical_boundaries]
        for index in range(1, len(vertical_boundaries)):
            vertical_boundaries[index] = max(vertical_boundaries[index], vertical_boundaries[index - 1] + 1.0)
        # Row bands depend on the horizontal colour steps; column boundaries are already constrained
        # by the cell boxes, so a weak vertical step must not veto an otherwise verified row grid.
        vertical_baseline = 0.45 if len(vertical_boundaries) >= 3 else 0.0
        confidence = float(np.clip(
            0.75 * confidence + 0.25 * max(vertical_confidence, vertical_baseline), 0.0, 1.0))
    else:
        vertical_boundaries = []
    inset = float(options.get("sampleInset", 0.12))
    # Sample inside the cell columns when they are known: this keeps the frame stroke/glow and the
    # side gutters (row icons, edge bloom) out of the row colour, which the full outer width includes.
    if len(columns) >= 2:
        sample_x0 = int(round(max(0, float(columns[0].get("x", left)) - left + 2)))
        sample_x1 = int(round(min(right - left, float(columns[-1].get("right", right)) - left - 2)))
    else:
        sample_x0, sample_x1 = int(round((right - left) * 0.01)), int(round((right - left) * 0.99))
    if sample_x1 - sample_x0 < 8:
        sample_x0, sample_x1 = int(round((right - left) * 0.01)), int(round((right - left) * 0.99))
    measured_rows = []
    for index, row in enumerate(rows):
        row_top = boundaries[index] if index < len(boundaries) else float(row.get("y", top))
        row_bottom = boundaries[index + 1] if index + 1 < len(boundaries) else float(row.get("bottom", bottom))
        slot_height = max(4.0, row_bottom - row_top)
        row_inset=min(inset,.035 if row.get('kind')=='header' else .06)
        y0 = int(round(row_top + max(2,slot_height * row_inset))) - top
        y1 = int(round(row_bottom - max(2,slot_height * row_inset))) - top
        x0, x1 = sample_x0, sample_x1
        y_bins = int(max(4, min(10, round(slot_height / 7.0))))
        bins, valid_pixels, coverage = sample_grid(local_image, table_mask,
                                                   (x0, y0, x1, y1), y_bins, 12)
        paint = row_paint(bins, options)
        if row.get('kind')=='header' and paint['solidError'] is not None and paint['solidError']>2:
            # A header can have a genuine two-dimensional glow/ramp. Fit its measured ink-free
            # pixels in the original row coordinates instead of forcing an axis-only band model.
            yy, xx = np.nonzero(table_mask[max(0,y0):min(table_mask.shape[0],y1), x0:x1])
            yy, xx = yy+max(0,y0), xx+x0
            stride=max(1,len(xx)//6000)
            xx,yy=xx[::stride],yy[::stride]
            if len(xx)>=80:
                current={'type':'linear','angle':90,'stops':[{'position':0,'color':paint['fill']},
                                                           {'position':1,'color':paint['fill']}]}
                rich=fit_native_paint(local_image[yy,xx],xx.astype(float),yy.astype(float),
                    {'x':0,'y':float(row_top-top),'w':float(right-left),'h':float(slot_height)},current,
                    budget={'maxCandidates':1800,'seconds':5})
                if rich and rich['afterError']<paint['error']*.7:
                    paint.update(gradient=rich['gradient'],fill=rich['gradient']['stops'][0]['color'],
                                 error=rich['afterError'],gradientEvidence={'method':'spatial-header-fit',
                                 'holdoutError':rich['holdoutError'],'type':rich['gradient']['type']})
        confidence_row = 0.0
        if paint["fill"]:
            confidence_row = float(np.clip(
                (0.35 + 0.65 * coverage) * (1.0 - min(0.8, paint["error"] / 40.0))
                * (0.4 + 0.6 * confidence), 0.0, 1.0))
        reliable = bool(paint["fill"]) and len(bins) >= 4 \
            and coverage >= float(options.get("minRowCoverage", 0.03)) \
            and confidence_row >= float(options.get("minRowConfidence", 0.2))
        if not reliable:
            issues.append("row-low-evidence:%s" % row.get("rowIndex"))
        measured_rows.append({
            "rowIndex": int(row.get("rowIndex", index)),
            "kind": row.get("kind", "data"),
            "fill": paint["fill"],
            "gradient": paint["gradient"],
            "colorGroup": None,
            "confidence": round(confidence_row, 4),
            "coverage": round(coverage, 4),
            "samples": len(bins),
            "reliable": reliable,
            "error": paint["error"],
            "solidError": paint["solidError"],
            "validPixels": valid_pixels,
            **({"gradientEvidence": paint["gradientEvidence"]}
               if paint["gradientEvidence"] else {}),
        })
    color_groups = cluster_rows(measured_rows, float(options.get("colorTolerance", 9.0)), table_id)
    data_ok = all(row.get("reliable") for row in measured_rows if row["kind"] != "header")
    header_ok = all(row.get("reliable") for row in measured_rows if row["kind"] == "header")
    if not data_ok or not header_ok:
        issues.append("row-colour-incomplete")
    if confidence < 0.5:
        issues.append("grid-low-confidence")
    status = "ok" if not issues else "partial"
    return {
        "tableId": table_id,
        "status": status,
        "outer":frame,
        "issues": issues,
        "grid": {"boundaries": [round(value, 1) for value in boundaries],
                 "verticalBoundaries": [round(value, 1) for value in vertical_boundaries],
                 "confidence": round(confidence, 4),
                 "source": "cells+colour-steps" if confidence >= 0.5 else "cell-constraints"},
        "rows": measured_rows,
        "colorGroups": color_groups,
        "alignment":measure_alignment(reference,cells,rows,boundaries,vertical_boundaries,options),
        "diagnostics": {"elapsedMs": round((time.perf_counter() - started) * 1000.0, 1)},
    }


def main():
    started = time.perf_counter()
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    out_path = sys.argv[2]
    scene = (int(spec.get("scene", {}).get("width", SCENE[0])),
             int(spec.get("scene", {}).get("height", SCENE[1])))
    options = {**DEFAULT_OPTIONS, **(spec.get("options") or {})}
    reference = load_image(spec["reference"], scene)
    # Sampling starts from the whole table crop; spec.exclude removes text/icons/lines. The
    # wordless-background difference is deliberately NOT applied (see measure_table).
    mask = np.full((scene[1], scene[0]), 255, np.uint8)
    tables = []
    for table in spec.get("tables") or []:
        try:
            tables.append(measure_table(table, reference, mask, options, scene))
        except Exception as error:  # one bad table must not break the page
            tables.append({"tableId": str(table.get("tableId") or ""), "status": "partial",
                           "issues": ["tool-error:%s" % str(error)[:120]],
                           "grid": {"boundaries": [], "verticalBoundaries": [], "confidence": 0.0,
                                    "source": "cell-constraints"},
                           "rows": [], "colorGroups": [], "diagnostics": {"elapsedMs": 0.0}})
    json.dump({"status": "available", "tables": tables,
               "diagnostics": {"engine": "table_rows.py", "version": 1,
                               "elapsedMs": round((time.perf_counter() - started) * 1000.0, 1)}},
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"status": "available", "tables": len(tables)}))


if __name__ == "__main__":
    main()
