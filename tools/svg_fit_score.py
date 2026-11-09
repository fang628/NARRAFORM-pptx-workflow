"""CLI/streaming entry for the shared cached SVG scoring context."""
import json
import sys
from pathlib import Path
from svg_fit_context import run

if __name__ == '__main__':
    if sys.argv[1] == '--serve':
        for line in sys.stdin:
            try:
                result = run(json.loads(line))
            except Exception as error:
                result = {'status': 'unavailable', 'scores': [], 'error': str(error)[:500]}
            print(json.dumps(result), flush=True)
    else:
        print(json.dumps(run(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))))
