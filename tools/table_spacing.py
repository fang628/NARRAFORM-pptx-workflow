"""Equal spacing is the table prior; only complete observed boundaries override it."""
import numpy as np


def regularize_axis(boundaries, role, strokes):
    if len(boundaries) < 2:
        return list(boundaries), {'source': 'unavailable', 'confidence': 0}
    observed = {s['boundaryIndex']: s for s in strokes
                if s.get('role') == role and s.get('source') == 'grid-boundary-ridge'
                and float(s.get('confidence', 0)) >= .80}
    complete = all(i in observed for i in range(len(boundaries)))
    if complete:
        return list(boundaries), {'source': 'complete-visible-boundaries',
                                  'confidence': min(observed[i]['confidence'] for i in observed),
                                  'boundaries': list(boundaries)}
    uniform = np.linspace(boundaries[0], boundaries[-1], len(boundaries)).tolist()
    return uniform, {'source': 'uniform-default', 'confidence': 0}
