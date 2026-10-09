# Shape text with HarfBuzz and extract outlines with fontTools; emit wordmark paths as JSON without system fonts.
import json, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

def shape(font_path, text, features, tracking_em=0.0):
    blob = hb.Blob.from_file_path(font_path)
    face = hb.Face(blob)
    font = hb.Font(face)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, features)
    tt = TTFont(font_path)
    upem = tt['head'].unitsPerEm
    gs = tt.getGlyphSet()
    order = tt.getGlyphOrder()
    x = 0
    parts = []
    track = tracking_em * upem
    n = len(buf.glyph_infos)
    for i, (info, pos) in enumerate(zip(buf.glyph_infos, buf.glyph_positions)):
        name = order[info.codepoint]
        pen = SVGPathPen(gs)
        # Font coordinates point upward; SVG points downward, so flip the y axis.
        tp = TransformPen(pen, (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset))
        gs[name].draw(tp)
        bp = BoundsPen(gs)
        gs[name].draw(TransformPen(bp, (1, 0, 0, -1, x + pos.x_offset, -pos.y_offset)))
        parts.append({'glyph': name, 'd': pen.getCommands(), 'x': x, 'adv': pos.x_advance, 'bounds': bp.bounds})
        x += pos.x_advance + (track if i < n - 1 else 0)
    os2 = tt['OS/2']
    return {'upem': upem, 'advance': x, 'capHeight': os2.sCapHeight, 'xHeight': os2.sxHeight, 'glyphs': parts}

if __name__ == '__main__':
    font, text, feats, track, out = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5]
    features = {f: True for f in feats.split(',') if f}
    res = shape(font, text, features, track)
    json.dump(res, open(out, 'w'))
    print(out, 'upem', res['upem'], 'cap', res['capHeight'], 'adv', res['advance'], [g['glyph'] for g in res['glyphs']])
