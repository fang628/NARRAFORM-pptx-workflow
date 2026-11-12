import cv2, json, sys
src, dst = sys.argv[1], sys.argv[2]
im = cv2.imread(src)
lab = cv2.cvtColor(im, cv2.COLOR_BGR2LAB)
l, a, b = cv2.split(lab)
mean_l = float(cv2.mean(l)[0])
l2 = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(l)
out = cv2.cvtColor(cv2.merge([l2, a, b]), cv2.COLOR_LAB2BGR)
out = cv2.addWeighted(out, 1.35, cv2.GaussianBlur(out, (0, 0), 3.0), -0.35, 0)
cv2.imwrite(dst, out)
json.dump({'dark': mean_l < 120.0, 'meanL': round(mean_l, 2), 'src': src, 'dst': dst},
          open(dst.rsplit('.', 1)[0] + '.json', 'w', encoding='utf-8'))
print(json.dumps({'dark': mean_l < 120.0, 'meanL': round(mean_l, 2)}))
