// Generate all deliverable files (called by build.js).
const B = require('./build');
const { C, fs, path, write, renderPng, fmt, transformPath, squircle } = B;
const { flattenPath } = require('./geom');

const MASTER = B.buildMark(B.MASTER);
const SMALL = B.buildMark(B.SMALL);
const OC = { master: B.opticalCenter(MASTER), small: B.opticalCenter(SMALL) };
const WM = JSON.parse(fs.readFileSync(path.join(__dirname, 'wordmark-outline.json'), 'utf8'));

const svgDoc = (w, h, inner, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(w, 2)}" height="${fmt(h, 2)}" viewBox="0 0 ${fmt(w, 3)} ${fmt(h, 3)}"${extra}>${inner}</svg>\n`;
const pick = (size) => (size <= 32 ? { mark: SMALL, oc: OC.small } : { mark: MASTER, oc: OC.master });

// Place the logo in a square, optically centered without exceeding margin.
// minMargin: minimum canvas-edge clearance during optical offset (default 2%); as fill approaches 1, naturally fall back to bounding-box centering.
function place(mark, oc, size, fill, minMargin = size * 0.02) {
  const h = mark.box[3] - mark.box[1], w = mark.box[2] - mark.box[0];
  const k = (size * fill) / h;
  const m = Math.min(minMargin, (size * (1 - fill)) / 2);
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const tx = clamp(size / 2 - oc.optical[0] * k, m - mark.box[0] * k, size - m - mark.box[2] * k);
  const ty = clamp(size / 2 - oc.optical[1] * k, m - mark.box[1] * k, size - m - mark.box[3] * k);
  return { k, tx, ty, w: w * k, h: h * k };
}

// 1. Logo marks.
function markSquare(size, variant, { fill = 0.96, small = false, bg = null, idp = 'onv' } = {}) {
  const { mark, oc } = small ? { mark: SMALL, oc: OC.small } : { mark: MASTER, oc: OC.master };
  const p = place(mark, oc, size, fill);
  const sh = B.markShapes(mark, p.k, p.tx, p.ty, variant, idp, size <= 64 ? 3 : 2);
  const bgEl = bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : '';
  return svgDoc(size, size, `${sh.defs ? `<defs>${sh.defs}</defs>` : ''}${bgEl}${sh.body}`);
}
function markTight(height, variant, idp = 'onv') {
  const mark = MASTER, k = height / (mark.box[3] - mark.box[1]);
  const w = (mark.box[2] - mark.box[0]) * k;
  const sh = B.markShapes(mark, k, -mark.box[0] * k, -mark.box[1] * k, variant, idp);
  return svgDoc(w, height, `${sh.defs ? `<defs>${sh.defs}</defs>` : ''}${sh.body}`);
}

// 2. Wordmarks and lockups.
function wordInk() {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const g of WM.glyphs) if (g.bounds) {
    b = [Math.min(b[0], g.bounds[0]), Math.min(b[1], g.bounds[1]), Math.max(b[2], g.bounds[2]), Math.max(b[3], g.bounds[3])];
  }
  return b;
}
const WORD_D = WM.glyphs.map((g) => g.d).join('');
const WINK = wordInk();
function wordPath(cap, x, baseline, dp = 2) {
  const k = cap / WM.capHeight;
  return { d: transformPath(WORD_D, k, x - WINK[0] * k, baseline, dp), w: (WINK[2] - WINK[0]) * k, top: baseline + WINK[1] * k, bottom: baseline + WINK[3] * k };
}
const TEXT = { dark: C.textOnDark, light: C.textOnLight, coral: C.coral, white: '#FFFFFF', black: '#000000' };
const STAR_VARIANT = { dark: 'dark', light: 'light', coral: 'dark', white: '#FFFFFF', black: '#000000' };

function wordmarkSvg(cap, tone) {
  const pad = 0;
  const wp = wordPath(cap, pad, -WINK[1] * (cap / WM.capHeight) + pad);
  const h = wp.bottom - wp.top + pad * 2;
  return svgDoc(wp.w + pad * 2, h, `<path fill="${TEXT[tone]}" d="${wp.d}"/>`);
}
// Beside text, align the N centerline with the capital-letter centerline (matching the UI, 08 section 2); return the text baseline for logo top markTop.
const nMiddle = (mark, m) => ((mark.nBox[1] + mark.nBox[3]) / 2 - mark.box[1]) * m;
const baselineBeside = (mark, m, cap, markTop) => markTop + nMiddle(mark, m) + cap / 2;
// Horizontal: N height = cap height x 1.25, vertically center N/text; gap = cap height x 0.42.
function horizontalSvg(cap, tone) {
  const mark = MASTER, m = (cap * 1.25) / (mark.nBox[3] - mark.nBox[1]);
  const textX = (mark.box[2] - mark.box[0]) * m + cap * 0.42;
  const baseline = baselineBeside(mark, m, cap, 0); // Star tip at y=0.
  const sh = B.markShapes(mark, m, -mark.box[0] * m, -mark.box[1] * m, STAR_VARIANT[tone], `onv-h-${tone}`, 2);
  const wp = wordPath(cap, textX, baseline);
  const W = textX + wp.w, H = Math.max((mark.box[3] - mark.box[1]) * m, wp.bottom);
  return svgDoc(W, H, `${sh.defs ? `<defs>${sh.defs}</defs>` : ''}${sh.body}<path fill="${TEXT[tone]}" d="${wp.d}"/>`);
}
// Stacked: logo above (height = cap height x 3.6), centered text below, gap = cap height x 0.6.
function stackedSvg(cap, tone) {
  const mark = MASTER, mh = cap * 3.6, m = mh / (mark.box[3] - mark.box[1]);
  const wp0 = wordPath(cap, 0, 0);
  const W = Math.max(wp0.w, (mark.box[2] - mark.box[0]) * m);
  const markCx = OC.master.optical[0] * m;
  const tx = W / 2 - markCx, ty = -mark.box[1] * m;
  const sh = B.markShapes(mark, m, tx, ty, STAR_VARIANT[tone], `onv-s-${tone}`, 2);
  const baseline = mh + cap * 0.6 + cap;
  const wp = wordPath(cap, (W - wp0.w) / 2, baseline);
  return svgDoc(W, wp.bottom, `${sh.defs ? `<defs>${sh.defs}</defs>` : ''}${sh.body}<path fill="${TEXT[tone]}" d="${wp.d}"/>`);
}

// 3. App icons.
const BODY = squircle(100, 100, 824, 824, 185.4, 0.6);
function appIconSvg({ small = false } = {}) {
  const mark = small ? SMALL : MASTER, oc = small ? OC.small : OC.master;
  const p = place(mark, oc, 1024, small ? 0.62 : 0.56);
  const sh = B.markShapes(mark, p.k, p.tx, p.ty, 'dark', 'onv-app', 2);
  const sc = [p.tx + ((mark.sBox[0] + mark.sBox[2]) / 2) * p.k, p.ty + ((mark.sBox[1] + mark.sBox[3]) / 2) * p.k];
  const glow = small ? '' : `<radialGradient id="onv-app-glow" cx="${fmt(sc[0], 1)}" cy="${fmt(sc[1], 1)}" r="230" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.core[1]}" stop-opacity=".2"/><stop offset="1" stop-color="${C.core[1]}" stop-opacity="0"/></radialGradient>`;
  return svgDoc(1024, 1024, `<defs>${sh.defs}
<linearGradient id="onv-app-hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".10"/><stop offset=".5" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>${glow}
<clipPath id="onv-app-clip"><path d="${BODY}"/></clipPath>
<filter id="onv-app-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000000" flood-opacity=".32"/></filter></defs>
<path d="${BODY}" fill="${C.iconBody}" filter="url(#onv-app-shadow)"/>
<g clip-path="url(#onv-app-clip)">${glow ? '<rect width="1024" height="1024" fill="url(#onv-app-glow)"/>' : ''}<rect width="1024" height="1024" fill="url(#onv-app-hl)"/></g>
<path d="${BODY}" fill="none" stroke="#FFFFFF" stroke-opacity=".08" stroke-width="2"/>
${sh.body}`);
}

// 4. ICO packaging (embedded PNG).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

// 5. Share images.
function ogSvg(lang) {
  const tag = lang === 'zh' ? 'Mac 上的 Homebrew 应用商店' : 'The Homebrew App Store for Mac';
  const sub = lang === 'zh' ? '浏览 · 搜索 · 一键安装与更新' : 'Browse · Search · Install &amp; update in one click';
  const ff = lang === 'zh' ? 'PingFang SC' : 'Inter';
  const cap = 64, mark = MASTER, m = (cap * 1.25) / (mark.nBox[3] - mark.nBox[1]);
  const x0 = 96, baseline = 296, markTop = baseline - baselineBeside(mark, m, cap, 0);
  // Match the homepage hero on the right: purple glow, dashed concentric rings, and app icons tilted -8 degrees (08 section 8.x featured hero).
  const icx = 940, icy = 318, isz = 330;
  const icon = appIconSvg().replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const sh = B.markShapes(mark, m, x0 - mark.box[0] * m, markTop - mark.box[1] * m, 'dark', 'onv-og', 2);
  const wp = wordPath(cap, x0 + (mark.box[2] - mark.box[0]) * m + cap * 0.42, baseline);
  const rings = [160, 235, 315].map((r) => `<circle cx="${icx}" cy="${icy}" r="${r}" fill="none" stroke="#FFFFFF" stroke-opacity=".13" stroke-dasharray="2 6"/>`).join('');
  return svgDoc(1200, 630, `<defs>${sh.defs}
<radialGradient id="glow" cx="${icx}" cy="${icy}" r="520" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#AAAAFF" stop-opacity=".55"/><stop offset=".16" stop-color="#6E6EEB" stop-opacity=".35"/><stop offset=".34" stop-color="#5050D6" stop-opacity=".18"/><stop offset=".52" stop-color="#3C3CB4" stop-opacity=".06"/><stop offset=".66" stop-color="#3C3CB4" stop-opacity="0"/></radialGradient></defs>
<rect width="1200" height="630" fill="${C.page}"/><rect width="1200" height="630" fill="url(#glow)"/>${rings}
<g transform="rotate(-8 ${icx} ${icy})"><svg x="${icx - isz / 2}" y="${icy - isz / 2}" width="${isz}" height="${isz}" viewBox="0 0 1024 1024">${icon}</svg></g>
${sh.body}<path fill="${C.textOnDark}" d="${wp.d}"/>
<text x="${x0}" y="392" font-family="${ff}" font-weight="600" font-size="${lang === 'zh' ? 40 : 36}" letter-spacing="-0.4" fill="#F99E70">${tag}</text>
<text x="${x0}" y="446" font-family="${ff}" font-size="24" fill="#A8A8A8">${sub}</text>`);
}


// Menu-bar template vector source: flatten the small version into polygons (22pt canvas, 16pt glyph height),
// for rasterization by apps/desktop/src-tauri/examples/generate_tray_icons.rs.
function trayPolygonSvg() {
  const p = place(SMALL, OC.small, 22, 16 / 22);
  const polys = [...flattenPath(transformPath(SMALL.n, p.k, p.tx, p.ty, 6)), ...flattenPath(transformPath(SMALL.star, p.k, p.tx, p.ty, 6))];
  const pts = (poly) => poly.map(([x, y]) => `${fmt(x, 3)},${fmt(y, 3)}`).join(' ');
  return svgDoc(22, 22, polys.map((poly) => `<polygon fill="#000000" points="${pts(poly)}"/>`).join(''));
}

// Constants used by brand.ts (24x24 view).
function logoConstants(small = false) {
  const mark = small ? SMALL : MASTER;
  const p = place(mark, small ? OC.small : OC.master, 24, 0.96);
  const X = (v) => p.tx + v * p.k, Y = (v) => p.ty + v * p.k;
  const pad = 0.48; // Match the top/bottom padding.
  const mx0 = X(mark.box[0]) - pad, mw = X(mark.box[2]) - X(mark.box[0]) + 2 * pad;
  const [sx0, sy0, sx1, sy1] = [X(mark.sBox[0]), Y(mark.sBox[1]), X(mark.sBox[2]), Y(mark.sBox[3])];
  const side = sy1 - sy0 + 2 * pad;
  // Upward offsets beside text: how far the N centerline and star area centroid sit below their view-box centers, as fractions of the view-box side.
  const nMid = (Y(mark.nBox[1]) + Y(mark.nBox[3])) / 2;
  const starMid = Y(areaCentroid(mark.star)[1]);
  return {
    viewBox: '0 0 24 24',
    markViewBox: `${fmt(mx0)} 0 ${fmt(mw)} 24`,
    markAspect: +(mw / 24).toFixed(4),
    starViewBox: `${fmt((sx0 + sx1) / 2 - side / 2)} ${fmt(sy0 - pad)} ${fmt(side)} ${fmt(side)}`,
    nCenterOffset: +((nMid - 12) / 24).toFixed(4),
    starCenterOffset: +((starMid - (sy0 - pad + side / 2)) / side).toFixed(4),
    outerPath: transformPath(mark.n, p.k, p.tx, p.ty, 3),
    innerPath: transformPath(mark.star, p.k, p.tx, p.ty, 3),
  };
}

// Area centroid enclosed by a path, using the shoelace formula after flattening.
function areaCentroid(d) {
  let a = 0, cx = 0, cy = 0;
  for (const poly of flattenPath(d, { curveSegments: 200 })) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length], c = x0 * y1 - x1 * y0;
      a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function buildAll() {
  const out = [];
  const add = (rel, data) => out.push(write(rel, data));
  const png = (svg, w) => renderPng(svg, w);

  // Marks: 24x24 square (UI, matching existing LOGO.viewBox), tight bounding box, and monochrome.
  for (const v of ['dark', 'light', 'mono']) {
    const name = { dark: 'mark', light: 'mark-on-light', mono: 'mark-mono' }[v];
    add(`logo/svg/${name}.svg`, markSquare(24, v));
    add(`logo/svg/${name}-tight.svg`, markTight(24, v));
  }
  add('logo/svg/mark-white.svg', markSquare(24, '#FFFFFF'));
  add('logo/svg/mark-black.svg', markSquare(24, '#000000'));
  add('logo/svg/mark-small.svg', markSquare(32, 'dark', { small: true, fill: 0.94 }));
  add('logo/svg/mark-small-on-light.svg', markSquare(32, 'light', { small: true, fill: 0.94 }));
  for (const s of [64, 128, 256, 512, 1024]) {
    add(`logo/png/mark/mark-${s}.png`, png(markSquare(s, 'dark', { fill: 0.9 })));
    add(`logo/png/mark/mark-on-light-${s}.png`, png(markSquare(s, 'light', { fill: 0.9 })));
    add(`logo/png/mark/mark-white-${s}.png`, png(markSquare(s, '#FFFFFF', { fill: 0.9 })));
    add(`logo/png/mark/mark-black-${s}.png`, png(markSquare(s, '#000000', { fill: 0.9 })));
  }

  // Wordmarks and lockups.
  for (const tone of ['dark', 'light', 'coral', 'white', 'black']) {
    const sfx = { dark: 'on-dark', light: 'on-light', coral: 'coral', white: 'white', black: 'black' }[tone];
    const h = horizontalSvg(100, tone), st = stackedSvg(100, tone), wm = wordmarkSvg(100, tone);
    add(`logo/svg/logo-horizontal-${sfx}.svg`, h);
    add(`logo/svg/logo-stacked-${sfx}.svg`, st);
    add(`logo/svg/wordmark-${sfx}.svg`, wm);
    for (const w of [480, 960, 1920]) add(`logo/png/horizontal/logo-horizontal-${sfx}-${w}w.png`, png(h, w));
    for (const w of [400, 800]) add(`logo/png/stacked/logo-stacked-${sfx}-${w}w.png`, png(st, w));
  }

  // App icons.
  const appSvg = appIconSvg(), appSmall = appIconSvg({ small: true });
  add('app-icon/app-icon.svg', appSvg);
  add('app-icon/app-icon-small.svg', appSmall);
  const iconPng = (s) => png(s <= 32 ? appSmall : appSvg, s);
  for (const s of [16, 32, 64, 128, 256, 512, 1024]) add(`app-icon/png/app-icon-${s}.png`, iconPng(s));
  const set = { 'icon_16x16': 16, 'icon_16x16@2x': 32, 'icon_32x32': 32, 'icon_32x32@2x': 64, 'icon_128x128': 128, 'icon_128x128@2x': 256, 'icon_256x256': 256, 'icon_256x256@2x': 512, 'icon_512x512': 512, 'icon_512x512@2x': 1024 };
  for (const [n, s] of Object.entries(set)) add(`app-icon/AppIcon.iconset/${n}.png`, iconPng(s));
  B.execFileSync('iconutil', ['-c', 'icns', path.join(B.ROOT, 'app-icon/AppIcon.iconset'), '-o', path.join(B.ROOT, 'app-icon/OpenNavo.icns')]);
  out.push(path.join(B.ROOT, 'app-icon/OpenNavo.icns'));

  // Icon Composer layers (macOS 26+ Liquid Glass): background, N, and star on a 1024 canvas.
  {
    const p = place(MASTER, OC.master, 1024, 0.56);
    const sh = B.markShapes(MASTER, p.k, p.tx, p.ty, 'dark', 'onv-layer', 2);
    const [nEl, sEl] = sh.body.split('/><').map((s, i) => (i === 0 ? s + '/>' : '<' + s));
    add('app-icon/icon-composer/1-n.svg', svgDoc(1024, 1024, `<defs>${sh.defs}</defs>${nEl}`));
    add('app-icon/icon-composer/2-star.svg', svgDoc(1024, 1024, `<defs>${sh.defs}</defs>${sEl}`));
    add('app-icon/icon-composer/0-background.svg', svgDoc(1024, 1024, `<rect width="1024" height="1024" fill="${C.iconBody}"/>`));
  }

  // Menu-bar template (black and transparent; the system applies color).
  const tray = (s) => png(markSquare(s, '#000000', { small: true, fill: 16 / 22 }), s);
  add('menubar/trayTemplate.png', tray(22));
  add('menubar/trayTemplate@2x.png', tray(44));
  add('menubar/menubarTemplate-18.png', png(markSquare(18, '#000000', { small: true, fill: 0.86 }), 18));
  add('menubar/menubarTemplate-18@2x.png', png(markSquare(36, '#000000', { small: true, fill: 0.86 }), 36));
  add('menubar/trayTemplate.svg', trayPolygonSvg());

  // Web: favicon (SVG star follows system light/dark mode), ICO, PNG, touch/PWA icons, and share images.
  {
    const p = place(SMALL, OC.small, 32, 0.94);
    const nD = transformPath(SMALL.n, p.k, p.tx, p.ty), sD = transformPath(SMALL.star, p.k, p.tx, p.ty);
    add('web/favicon.svg', svgDoc(32, 32, `<style>.a{stop-color:${C.starOnLight[0]}}.b{stop-color:${C.starOnLight[1]}}@media (prefers-color-scheme:dark){.a{stop-color:${C.core[0]}}.b{stop-color:${C.core[1]}}}</style>
<defs><linearGradient id="n" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.logo[0]}"/><stop offset=".55" stop-color="${C.logo[1]}"/><stop offset="1" stop-color="${C.logo[2]}"/></linearGradient><linearGradient id="s" x1="0" y1="0" x2="1" y2="1"><stop class="a" offset="0"/><stop class="b" offset="1"/></linearGradient></defs>
<path fill="url(#n)" d="${nD}"/><path fill="url(#s)" d="${sD}"/>`));
    const fav = (s) => png(markSquare(s, 'light', { small: s <= 32, fill: 0.94 }), s);
    add('web/favicon.ico', ico([16, 32, 48].map((s) => ({ size: s, data: fav(s) }))));
    add('web/favicon-16.png', fav(16));
    add('web/favicon-32.png', fav(32));
    add('web/apple-touch-icon.png', png(markSquare(180, 'dark', { fill: 0.6, bg: C.iconBody }), 180));
    add('web/icon-192.png', png(appSvg, 192));
    add('web/icon-512.png', png(appSvg, 512));
    add('web/icon-maskable-512.png', png(markSquare(512, 'dark', { fill: 0.5, bg: C.iconBody }), 512));
    add('web/site.webmanifest', JSON.stringify({
      name: 'OpenNavo', short_name: 'OpenNavo', theme_color: C.page, background_color: C.page, display: 'standalone',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }, null, 2) + '\n');
    for (const lang of ['zh', 'en']) {
      const og = ogSvg(lang);
      add(`web/og-image-${lang}.svg`, og);
      add(`web/og-image-${lang}.png`, png(og, 1200));
    }
  }

  // Tauri desktop icons: same filenames as apps/desktop/src-tauri/icons, ready for directory-wide replacement.
  for (const [n, s] of Object.entries({ '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512, 'app-icon.png': 1024 })) add(`tauri-icons/${n}`, iconPng(s));
  add('tauri-icons/app-icon.svg', appSvg);
  fs.copyFileSync(path.join(B.ROOT, 'app-icon/OpenNavo.icns'), path.join(B.ROOT, 'tauri-icons/icon.icns'));
  out.push(path.join(B.ROOT, 'tauri-icons/icon.icns'));
  add('tauri-icons/trayTemplate.svg', trayPolygonSvg());
  add('tauri-icons/trayTemplate.png', tray(22));
  add('tauri-icons/trayTemplate@2x.png', tray(44));

  // Integration reference: 24x24 paths that can replace LOGO in packages/shared/src/brand.ts.
  {
    const L = logoConstants();
    const small = logoConstants(true);
    add('integration/brand-logo.ts', `// New logo geometry (24x24 view), replacing LOGO in packages/shared/src/brand.ts
// Colors from tokens: N uses brand.logoGradient, star uses brand.logoCoreGradient; on light backgrounds use brand.logoCoreGradientOnLight.
export const LOGO = {
  /** Square view box: optically centered mark for standalone use such as favicons and loading screens. */
  viewBox: '${L.viewBox}',
  /** Tight bounding box for horizontal layouts such as wordmark lockups and sidebars, avoiding side padding. */
  markViewBox: '${L.markViewBox}',
  /** Aspect ratio of markViewBox. */
  markAspect: ${L.markAspect},
  /** Square view box for a standalone North Star (badge decoration, paired with innerPath). */
  starViewBox: '${L.starViewBox}',
  /** N centerline offset below the view-box center, as a fraction of its height; shift up by this amount to align beside text. */
  nCenterOffset: ${L.nCenterOffset},
  /** Star area-centroid offset below the starViewBox center, as a fraction of its side; use for area-centered alignment beside text. */
  starCenterOffset: ${L.starCenterOffset},
  /** Letter N. */
  outerPath: '${L.outerPath}',
  /** North Star. */
  innerPath: '${L.innerPath}',
  /** Small-size geometry for 32px and below. */
  small: ${JSON.stringify(small, null, 2)}
} as const;
`);
  }
  return out;
}

module.exports = { buildAll, MASTER, SMALL, OC, place, markSquare, horizontalSvg, stackedSvg, appIconSvg, wordmarkSvg, logoConstants, trayPolygonSvg, areaCentroid };
