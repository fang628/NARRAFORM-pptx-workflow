"""Bridge bare DrawingML RGB colors to SVG CSS paint attributes."""
import re

PAINT_ATTRIBUTES = {'fill', 'stroke', 'stop-color', 'flood-color', 'color'}


def normalize_svg_colors(root):
    repairs = []
    for node in root.iter():
        for name in PAINT_ATTRIBUTES:
            original = node.get(name)
            if original is not None and re.fullmatch(r'(?:[\da-fA-F]{3,4}|[\da-fA-F]{6}|[\da-fA-F]{8})', original.strip()):
                corrected = '#' + original.strip().upper()
                node.set(name, corrected)
                repairs.append({'attribute': name, 'from': original, 'to': corrected})
    return repairs
