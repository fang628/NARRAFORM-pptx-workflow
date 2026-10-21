"""Sample the common background and its bottom-right reading area locally."""
import json
import sys
from PIL import Image

with Image.open(sys.argv[1]) as source:
    image = source.convert('RGB')
    corner = image.crop((round(image.width*.88), round(image.height*.87), image.width, image.height))
    def colors(im):
        q = im.resize((96, 64)).quantize(colors=24)
        p = q.getpalette()
        return [tuple(p[i*3:i*3+3]) for _, i in sorted(q.getcolors(), reverse=True)]
    background = colors(corner)[0]
    palette = colors(image)
    accent = next((c for c in palette if max(c)-min(c) > 40), palette[0])
    print(json.dumps(dict(background='%02X%02X%02X' % background, accent='%02X%02X%02X' % accent)))
