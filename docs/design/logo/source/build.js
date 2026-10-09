// OpenNavo logo asset build script.
// Usage: cd source && npm i && node build.js (macOS iconutil is required for .icns).
// wordmark.py pre-extracts Inter Display SemiBold outlines (cv11 single-storey a) into wordmark-outline.json.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
// Prefer dependencies installed here; in the repository, reuse the same dependency installed by apps/web.
function loadResvg() {
  for (const base of [__dirname, path.resolve(__dirname, '../../../../apps/web')]) {
    try {
      return require(require.resolve('@resvg/resvg-js', { paths: [base] }));
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Missing @resvg/resvg-js: run npm i in this directory');
}
const { Resvg } = loadResvg();
const { fmt, buildMark, transformPath, squircle } = require('./geom');

// Output: rebuild in place in the asset bundle (brand-guide.html in parent); repository copies default to ignored ./out.
const ROOT = process.env.LOGO_OUT_DIR
  ? path.resolve(process.env.LOGO_OUT_DIR)
  : fs.existsSync(path.resolve(__dirname, '..', 'brand-guide.html'))
    ? path.resolve(__dirname, '..')
    : path.join(__dirname, 'out');
const FONT_DIR = process.env.INTER_TTF_DIR || path.join(__dirname, 'fonts');

// Colors: all from packages/tokens/tokens.json; no new tokens.
const { color } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../packages/tokens/tokens.json'), 'utf8'));
const C = {
  logo: color.brand.logoGradient.value,
  core: color.brand.logoCoreGradient.value,
  starOnLight: color.brand.logoCoreGradientOnLight.value,
  coral: color.brand.coral.value,
  textOnDark: color.text.primary.value,
  textOnLight: color.text.inverse.value,
  iconBody: color.surface.sidebar.value,
  page: color.surface.page.value,
  violet: color.brand.violet.value,
};

// Logo parameters (design units).
// Master version: sizes above 32px.
const MASTER = {
  n: { W: 62, H: 74, s: 16.5, t: 16, yR: 23, r: { term: 2.2, outer: 10, apex: 6, inner: 1 } },
  star: { cy: -3, top: 32, side: 16.5, bottom: 17, pull: 0.54 },
};
// Small version: 32px and below, with thicker strokes, fuller star, and wider gap.
const SMALL = {
  n: { W: 64, H: 74, s: 19, t: 18, yR: 27, r: { term: 1.5, outer: 8, apex: 4, inner: 0.5 } },
  star: { cy: -1, top: 30, side: 18.5, bottom: 17, pull: 0.48 },
};

const write = (rel, data) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const fontFiles = ['Inter-SemiBold.ttf', 'Inter-Regular.ttf', 'Inter-Medium.ttf', 'InterDisplay-SemiBold.ttf']
  .map((n) => path.join(FONT_DIR, n))
  .filter((f) => fs.existsSync(f));
function renderPng(svg, width) {
  const opts = { font: { loadSystemFonts: true, fontFiles, defaultFontFamily: 'Inter' }, shapeRendering: 2 };
  if (width) opts.fitTo = { mode: 'width', value: width };
  return new Resvg(svg, opts).render().asPng();
}
function renderRgba(svg, width) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
  return { w: r.width, h: r.height, px: r.pixels };
}

// Logo SVG fragments.
// variant: 'dark' (cream star) | 'light' (amber star) | 'mono' (currentColor) | literal color (monochrome).
function markShapes(mark, k, tx, ty, variant, idp, dp = 3) {
  const nD = transformPath(mark.n, k, tx, ty, dp), sD = transformPath(mark.star, k, tx, ty, dp);
  if (variant === 'mono' || variant.startsWith('#')) {
    const fill = variant === 'mono' ? 'currentColor' : variant;
    return { defs: '', body: `<path fill="${fill}" d="${nD}"/><path fill="${fill}" d="${sD}"/>` };
  }
  const star = variant === 'light' ? C.starOnLight : C.core;
  const defs =
    `<linearGradient id="${idp}-n" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.logo[0]}"/><stop offset=".55" stop-color="${C.logo[1]}"/><stop offset="1" stop-color="${C.logo[2]}"/></linearGradient>` +
    `<linearGradient id="${idp}-s" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${star[0]}"/><stop offset="1" stop-color="${star[1]}"/></linearGradient>`;
  return { defs, body: `<path fill="url(#${idp}-n)" d="${nD}"/><path fill="url(#${idp}-s)" d="${sD}"/>` };
}

// Optical center: blend area centroid with bounding-box center so the bottom-heavy N does not look sunken.
function opticalCenter(mark) {
  const [x0, y0, x1, y1] = mark.box;
  const scale = 4;
  const w = Math.ceil((x1 - x0) * scale), h = Math.ceil((y1 - y0) * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}"><path d="${mark.n}"/><path d="${mark.star}"/></svg>`;
  const { px } = renderRgba(svg, w);
  let sx = 0, sy = 0, sa = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = px[(y * w + x) * 4 + 3];
    if (a) { sx += x * a; sy += y * a; sa += a; }
  }
  const cx = x0 + sx / sa / scale, cy = y0 + sy / sa / scale;
  const bx = (x0 + x1) / 2, by = (y0 + y1) / 2;
  return { centroid: [cx, cy], bbox: [bx, by], optical: [bx + (cx - bx) * 0.5, by + (cy - by) * 0.35] };
}

// Place the logo in a square of side size, occupying fill of its height and optically centered.
function placeInSquare(mark, oc, size, fill) {
  const k = (size * fill) / (mark.box[3] - mark.box[1]);
  return { k, tx: size / 2 - oc.optical[0] * k, ty: size / 2 - oc.optical[1] * k };
}

module.exports = { C, MASTER, SMALL, buildMark, markShapes, opticalCenter, placeInSquare, renderPng, renderRgba, write, squircle, transformPath, fmt, ROOT, zlib, execFileSync, fs, path };

if (require.main === module) {
  require('./assets').buildAll();
  // Generate specification-page diagrams only inside the asset bundle.
  if (fs.existsSync(path.join(__dirname, 'guide.js'))) require('./guide').buildGuide();
}
