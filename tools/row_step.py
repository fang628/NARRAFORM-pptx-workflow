import cv2
import json
import sys
import numpy as np

image, x, y, w, h = sys.argv[1], *map(float, sys.argv[2:6])
page_width = float(sys.argv[6]) if len(sys.argv) > 6 else 1600.0
data = cv2.imread(image)
ratio = data.shape[1] / page_width
x0, y0 = int(round(x * ratio)), int(round(y * ratio))
x1, y1 = int(round((x + w) * ratio)), int(round((y + h) * ratio))
patch = data[max(0, y0):y1, max(0, x0):x1].astype(np.float32)
rows = np.asarray([np.median(patch[row].reshape(-1, 3), axis=0) for row in range(patch.shape[0])])
steps = np.linalg.norm(np.diff(rows, axis=0), axis=1) if len(rows) > 1 else np.zeros(1)
# skip the outer edges of the crop (card border/gradient start) and look inside the header area
count = len(steps)
start = max(1, int(0.20 * count))
end = max(start + 1, int(0.92 * count))
segment = steps[start:end]
index = int(np.argmax(segment)) + start
boundary = y + (index + 0.5) / ratio
top = np.median(rows[:max(1, index)], axis=0)
bottom = np.median(rows[min(len(rows) - 1, index + 1):], axis=0)
to_hex = lambda color: '%02x%02x%02x' % (int(color[2]), int(color[1]), int(color[0]))
print(json.dumps({'boundaryY': round(boundary, 1), 'delta': round(float(steps[index]), 1),
                  'topColor': to_hex(top), 'bottomColor': to_hex(bottom),
                  'topL': round(float(top.mean()), 1), 'rowCount': int(count)}))
