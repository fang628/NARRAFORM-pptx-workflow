"""Equal spacing is the table prior; only complete observed boundaries override it."""
import numpy as np


def regularize_axis(boundaries, role, strokes, visible_confidence=0):
    if len(boundaries) < 2:
        return list(boundaries), {'source': 'unavailable', 'confidence': 0}
    observed = {s['boundaryIndex']: s for s in strokes
                if s.get('role') == role and s.get('source') == 'grid-boundary-ridge'
                and float(s.get('confidence', 0)) >= .80}
    if visible_confidence >= .8 or all(i in observed for i in range(len(boundaries))):
        confidence = visible_confidence or min(observed[i]['confidence'] for i in range(len(boundaries)))
        return list(boundaries), {'source': 'complete-visible-boundaries',
                                  'confidence': confidence,
                                  'boundaries': list(boundaries)}
    uniform = np.linspace(boundaries[0], boundaries[-1], len(boundaries)).tolist()
    return uniform, {'source': 'uniform-default', 'confidence': 0}
