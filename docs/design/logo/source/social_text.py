# Outline social-banner text using wordmark.py HarfBuzz shaping (cv11 single-storey a and ss01 match the UI; resvg lacks font-feature-settings).
# Write social-text.json for social.js layout. Rerun after editing copy:
#   uv run --no-project --with fonttools --with uharfbuzz python -I social_text.py <Inter-font-directory>
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.dont_write_bytecode = True  # Do not create __pycache__ in the source directory when importing wordmark.py
from wordmark import shape  # noqa: E402

FEATURES = {'cv11': True, 'ss01': True}
# Key -> (font file, text, tracking in em); tracking comes from tokens.json typography (hero -0.035em, label 0.02em).
LINES = {
    'x.eyebrow': ('Inter-Medium.ttf', 'Open source', 0.02),
    'x.title1': ('InterDisplay-SemiBold.ttf', 'The Homebrew', -0.035),
    'x.title2': ('InterDisplay-SemiBold.ttf', 'App Store for Mac', -0.035),
    'x.sub': ('Inter-Regular.ttf', 'Browse · Search · Install & update in one click', 0),
}


def explicit(d):
    # SVGPathPen omits L after M (implicit line), which geom.js transformPath treats as another M; restore the command letter.
    parts, cmd, n = [], None, 0
    for tok in re.findall(r'[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?', d):
        if tok.isalpha():
            cmd, n = tok, 0
            parts.append(tok)
            continue
        if cmd == 'M' and n == 2:
            cmd, n = 'L', 0
            parts.append('L')
        if not parts[-1].isalpha():
            parts.append(' ')
        parts.append(tok)
        n += 1
    return ''.join(parts)


def line(font_dir, font, text, tracking):
    res = shape(os.path.join(font_dir, font), text, FEATURES, tracking)
    boxes = [g['bounds'] for g in res['glyphs'] if g['bounds']]
    ink = [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]
    return {
        'font': font, 'text': text, 'tracking': tracking, 'upem': res['upem'], 'capHeight': res['capHeight'],
        'advance': res['advance'], 'ink': ink, 'd': ''.join(explicit(g['d']) for g in res['glyphs']),
    }


if __name__ == '__main__':
    font_dir = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('INTER_TTF_DIR', os.path.join(HERE, 'fonts'))
    out = {k: line(font_dir, *v) for k, v in LINES.items()}
    with open(os.path.join(HERE, 'social-text.json'), 'w') as f:
        json.dump(out, f, ensure_ascii=False)
    for k, v in out.items():
        print(k, 'adv', v['advance'], 'ink', [round(x) for x in v['ink']], 'cap', v['capHeight'], 'upem', v['upem'])
