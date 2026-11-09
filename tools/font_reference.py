"""Bounded local font search; semantic text and scene boxes are never changed.

Pillow supplies candidate glyphs, OpenCV supplies symmetric edge distance.
These are only proposals: actual PowerPoint comparison decides acceptance.
"""
import json
import os
import re
import sys
import time
from functools import lru_cache
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

cv2.setNumThreads(1)
ALIASES = {'微软雅黑': 'Microsoft YaHei', '宋体': 'SimSun', '黑体': 'SimHei', '等线': 'DengXian'}
COMMON = {'Microsoft YaHei': ['msyh.ttc', 'msyhbd.ttc'], 'SimSun': ['simsun.ttc', 'simsun.ttc'], 'SimHei': ['simhei.ttf', 'simhei.ttf'], 'DengXian': ['Deng.ttf', 'Dengb.ttf'], 'Arial': ['arial.ttf', 'arialbd.ttf'], 'Times New Roman': ['times.ttf', 'timesbd.ttf'], 'Calibri': ['calibri.ttf', 'calibrib.ttf'], 'Cambria': ['cambria.ttc', 'cambriab.ttf'], 'Consolas': ['consola.ttf', 'consolab.ttf']}

def key(s):
    return re.sub(r'[\s_-]', '', s).lower()

@lru_cache(maxsize=1)
def registry():
    records = []
    if os.name == 'nt':
        import winreg
        for hive in [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]:
            try:
                with winreg.OpenKey(hive, r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts') as reg:
                    for i in range(winreg.QueryInfoKey(reg)[1]):
                        label, file, kind = winreg.EnumValue(reg, i)
                        # Font registry keys can contain bookkeeping DWORDs or
                        # other metadata, which are not font file paths.
                        if not isinstance(file,str) or not file.strip():
                            continue
                        file = Path(os.path.expandvars(file))
                        if not file.is_absolute():
                            file = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / file
                        if file.is_file():
                            records.append((label, str(file)))
            except OSError:
                pass
    return records

def locate(family, bold=False, italic=False):
    bold, italic = bool(bold), bool(italic)
    family = ALIASES.get(family, family)
    if family in COMMON:
        file = Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts' / COMMON[family][int(bold)]
        if italic and family in ('Arial', 'Times New Roman', 'Calibri', 'Consolas'):
            names = {'Arial': ('ariali.ttf', 'arialbi.ttf'), 'Times New Roman': ('timesi.ttf', 'timesbi.ttf'), 'Calibri': ('calibrii.ttf', 'calibriz.ttf'), 'Consolas': ('consolai.ttf', 'consolaz.ttf')}
            file = file.parent / names[family][int(bold)]
        if file.is_file():
            return str(file)
    matches = [(abs(int('bold' in label.lower())-int(bold))+abs(int('italic' in label.lower())-int(italic)), file) for label, file in registry() if key(family) in key(label)]
    return min(matches)[1] if matches else None

def cropped(mask):
    ys, xs = np.where(mask > .1)
    return mask[ys.min():ys.max()+1, xs.min():xs.max()+1] if len(xs) else None

def render(e, font, size, spacing, line_spacing):
    try:
        face = ImageFont.truetype(font, max(1, round(size)))
    except (OSError,ValueError):
        return None
    canvas = Image.new('L', (max(8, round(e['w'])+20), max(8, round(e['h']*1.5)+20)))
    draw = ImageDraw.Draw(canvas)
    y = 0
    lines = []
    # Honor explicit newlines and the same text box width; never alter the text.
    for paragraph in e['text'].split('\n'):
        line = ''
        for char in paragraph:
            test = line + char
            if line and draw.textlength(test, font=face)+spacing*(len(test)-1) > e['w'] and not e.get('noWrap'):
                lines.append(line)
                line = char
            else:
                line = test
        lines.append(line)
    for line in lines:
        x = 0
        # Drawing the full line retains kerning for the common zero-spacing case.
        if abs(spacing) < .01:
            draw.text((x, y), line, font=face, fill=255, anchor='lt')
        else:
            for char in line:
                draw.text((x, y), char, font=face, fill=255, anchor='lt')
                x += draw.textlength(char, font=face)+spacing
        y += line_spacing
    return cropped(np.asarray(canvas, np.float32)/255)

def score(a, b):
    if b is None:
        return 0
    h, w = max(a.shape[0], b.shape[0])+8, max(a.shape[1], b.shape[1])+8
    if h*w > 2000000:
        return 0
    masks = []
    for source in [a, b]:
        m = np.zeros((h, w), np.uint8)
        y, x = (h-source.shape[0])//2, (w-source.shape[1])//2
        m[y:y+source.shape[0], x:x+source.shape[1]] = (source > .3).astype(np.uint8)
        masks.append(m)
    aa, bb = masks
    distances = [cv2.distanceTransform(1-aa, cv2.DIST_L2, 3)[bb > 0], cv2.distanceTransform(1-bb, cv2.DIST_L2, 3)[aa > 0]]
    distance = np.mean(np.concatenate(distances))
    area = min(aa.sum(), bb.sum())/max(1, max(aa.sum(), bb.sum()))
    return float(.8*np.exp(-distance/2.5)+.2*area)

def build(spec):
    started = time.monotonic()
    ref = np.asarray(Image.open(spec['reference']).convert('RGB').resize((1600, 900)), np.float32)
    proposals, skipped = [], []
    for e in spec.get('elements', [])[:20]:
        if time.monotonic()-started > 18:
            break
        text = e.get('text', '')
        if not text or re.search(r'[\^_$<>]|[\u0590-\u08ff\u0900-\u0dff]', text) or e.get('rotate') or e.get('artisticText') or e.get('managed'):
            continue  # Inline math and complex shaping need their own native path.
        x, y, w, h = [int(round(e.get(k, 0))) for k in ('x', 'y', 'w', 'h')]
        if x < 0 or y < 0 or w < 4 or h < 4 or x+w > 1600 or y+h > 900:
            continue
        color = e.get('color', '222222').lstrip('#')
        if not re.fullmatch(r'[\da-fA-F]{6}', color):
            continue
        ink = np.array([int(color[i:i+2], 16) for i in (0, 2, 4)])
        region = ref[y:y+h, x:x+w]
        mask = np.clip(1-np.linalg.norm(region-ink, axis=2)/75, 0, 1)
        target = cropped(mask)
        if target is None or (mask > .3).sum() < 25 or np.mean(mask > .3) > .55:
            skipped.append(e['key'])
            continue
        family = ALIASES.get(e.get('fontFace'), e.get('fontFace')) or 'Microsoft YaHei'
        cjk = bool(re.search(r'[\u3400-\u9fff]', text))
        families = list(dict.fromkeys([family]+spec.get('families', (['Microsoft YaHei', 'SimSun', 'DengXian'] if cjk else ['Arial', 'Calibri', 'Times New Roman']))))[:4]
        size, spacing, line = float(e['size']), float(e.get('charSpacing') or 0), float(e.get('lineSpacing') or e['size']*1.2)
        file = locate(family, e.get('bold'), e.get('italic'))
        if not file:
            continue
        baseline = score(target, render(e, file, size, spacing, line))
        best = (baseline, {'fontFace': family, 'size': size, 'charSpacing': spacing, 'lineSpacing': line})
        for name in families:
            file = locate(name, e.get('bold'), e.get('italic'))
            if not file:
                continue
            # No simulated italic or synthetic bold: only actual installed faces.
            for scale in [.94, 1, 1.06]:
                candidate_size = round(size*scale, 2)
                if candidate_size < min(20, size):
                    continue
                for gap in [spacing, spacing-size*.02, spacing+size*.02]:
                    if time.monotonic()-started > 18:
                        break
                    offsets = [0, -size*.08, size*.08] if '\n' in text or target.shape[0] > size*1.8 else [0]
                    for offset in offsets:
                        candidate_line = max(candidate_size, line*scale+offset)
                        value = score(target, render(e, file, candidate_size, gap, candidate_line))
                        if value > best[0]+.004:
                            best = (value, {'fontFace': name, 'size': candidate_size, 'charSpacing': round(gap, 3), 'lineSpacing': round(candidate_line, 3)})
        if best[0] > baseline+.025 and best[0] > .65:
            proposals.append({'key': e['key'], 'properties': best[1], 'beforeScore': baseline, 'afterScore': best[0], 'confidence': .9})
    return {'status': 'available', 'proposals': proposals, 'skipped': skipped, 'elapsedMs': round((time.monotonic()-started)*1000)}

if __name__ == '__main__':
    print(json.dumps(build(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))), ensure_ascii=False))
