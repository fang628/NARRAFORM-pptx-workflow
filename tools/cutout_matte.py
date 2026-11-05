"""Choose a chroma matte that is distant from the observed foreground colours."""
import cv2
import numpy as np
from PIL import Image

CANDIDATES = [
    ('FF00FF', '洋红'), ('00FF00', '荧光绿'), ('00FFFF', '青'),
    ('0000FF', '蓝'), ('FF8000', '橙'),
]


def choose_matte(image, background):
    rgba = np.asarray(image.convert('RGBA'))
    rgb = rgba[:, :, :3].astype(np.float32)
    base = np.asarray(background.convert('RGB').resize(image.size, Image.Resampling.LANCZOS)).astype(np.float32)
    difference = np.linalg.norm(rgb-base, axis=2)
    mask = (difference > 28) & (rgba[:, :, 3] > 32)
    mode = 'reference-foreground'
    if mask.sum() < 8:
        mask = rgba[:, :, 3] > 32
        mode = 'source-colours'
    colours = rgb[mask]
    if not len(colours):
        raise ValueError('目标区域没有可分析的可见颜色')
    # Aggregate occupied RGB bins instead of frequency sampling: thin coloured
    # strokes must influence the matte choice even beside a large white body.
    quantized = np.floor(colours / 8).astype(np.int16)
    _, indices = np.unique(quantized, axis=0, return_index=True)
    colours = colours[indices]
    lab = cv2.cvtColor((colours/255).reshape(1, -1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3)
    scored = []
    for hex_colour, name in CANDIDATES:
        candidate = np.array([int(hex_colour[i:i+2], 16) for i in (0, 2, 4)], dtype=np.float32)
        candidate_lab = cv2.cvtColor((candidate/255).reshape(1, 1, 3), cv2.COLOR_RGB2LAB)[0, 0]
        distances = np.linalg.norm(lab-candidate_lab, axis=1)
        nearest, low = float(distances.min()), float(np.percentile(distances, 10))
        # Prefer separating every occupied colour, then the lower-tail distance.
        score = .8*nearest + .2*low
        scored.append(dict(hex=hex_colour, name=name, minimumDistance=nearest, lowPercentileDistance=low, score=score))
    selected = max(scored, key=lambda item: item['score'])
    return {**selected, 'selectionMode': mode, 'foregroundPixels': int(mask.sum()), 'analysedColourBins': len(colours)}
