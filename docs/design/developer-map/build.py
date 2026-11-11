#!/usr/bin/env python3
"""Assemble the self-contained developer-map prototype from src/ + generated assets."""
import json, re, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
ASSETS = os.path.join(HERE, 'src/assets.json')

COUNTRIES = {
    'US': (486, 4210), 'GB': (98, 356), 'CN': (90, 388), 'JP': (60, 274),
    'AU': (57, 251), 'CZ': (44, 196), 'NL': (42, 188), 'UA': (38, 171),
    'DE': (30, 142), 'CA': (28, 130), 'FR': (26, 121), 'AT': (20, 92),
    'KR': (14, 64), 'IN': (8, 38), 'IL': (7, 33), 'IT': (5, 24), 'SE': (5, 24),
}

def level(count):
    if count == 0: return 0
    if count < 10: return 1
    if count < 30: return 2
    if count < 80: return 3
    if count < 200: return 4
    return 5

assets = json.load(open(ASSETS))
world = assets['world']

paths = []
for country in world['countries']:
    cc = country['id']
    count, apps = COUNTRIES.get(cc, (0, 0))
    name = country.get('zh') or country.get('en') or cc
    paths.append(
        f'<path class="dm-land" data-level="{level(count)}" data-cc="{cc}" '
        f'data-name="{name}" data-count="{count}" data-apps="{apps}" d="{country["path"]}"/>'
    )
countries_html = '\n'.join(paths)

# icon symbols
symbols = []
for key, value in assets['icons'].items():
    symbols.append(f'<symbol id="ic-{key}" viewBox="{value["vb"]}">{value["body"]}</symbol>')
for key, value in assets['lucide'].items():
    symbols.append(f'<symbol id="ic-{key}" viewBox="{value["vb"]}">{value["body"]}</symbol>')
icons_html = '\n'.join(symbols)

# logo
mark = open(os.path.join(ROOT, 'docs/design/logo/svg/mark.svg')).read()
logo_defs = re.search(r'<defs>.*?</defs>', mark, re.S).group(0)
wordmark = open(os.path.join(ROOT, 'docs/design/logo/svg/wordmark-on-dark.svg')).read()
wordmark_body = re.search(r'(<path.*?/>)', wordmark, re.S).group(1)
wordmark_body = wordmark_body.replace('fill="#EDEDED"', 'fill="currentColor"')
wordmark_symbol = (
    '<symbol id="brand-wordmark" viewBox="0 0 639.616 129.664">'
    + wordmark_body
    + '</symbol>'
)

tokens = open(os.path.join(ROOT, 'packages/tokens/dist/tokens.css')).read()
style = open(os.path.join(HERE, 'src/style.css')).read().replace('__FONT_B64__', assets['font'])
body = open(os.path.join(HERE, 'src/body.html')).read()
app = open(os.path.join(HERE, 'src/app.js')).read()

html = f'''<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>开发者地图 · OpenNavo 设计提案</title>
<meta name="description" content="OpenNavo 发现页「开发者地图」高保真方案：网页与 macOS 客户端。">
<style>
/* OpenNavo design tokens (packages/tokens/dist/tokens.css) */
{tokens}
</style>
<style>
{style}
</style>
</head>
<body data-mode="web">
{body.replace('<!--LOGO_DEFS-->', logo_defs).replace('<!--WORDMARK-->', wordmark_symbol).replace('<!--ICONS-->', icons_html).replace('<!--COUNTRIES-->', countries_html)}
<script>
{app}
</script>
</body>
</html>
'''

out = os.path.join(HERE, 'index.html')
open(out, 'w').write(html)
print('wrote', out, f'{len(html)/1024:.0f} KB')
print('countries', len(world['countries']), 'icons', len(assets['icons']), 'lucide', len(assets['lucide']))
