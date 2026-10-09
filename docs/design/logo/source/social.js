// Social banner: X (Twitter) header, 1500 x 500.
// Usage: node social.js -> out/social/x-banner.svg, x-banner.png, and x-banner-preview.png with avatar overlay.
// social_text.py pre-converts text to outlines (social-text.json, cv11 single-storey a matching the UI); this script handles composition.
// Composition: lower-left avatar/logo, glow and concentric dashed orbits centered on it, app tiles on orbits; headline on the right, clear of the avatar.
const B = require('./build');
const { MASTER, areaCentroid } = require('./assets');
const { C, fs, path, write, renderPng, fmt, transformPath, squircle } = B;

const TOKENS = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../packages/tokens/tokens.json'), 'utf8'));
const TEXT = JSON.parse(fs.readFileSync(path.join(__dirname, 'social-text.json'), 'utf8'));
// Tile icons use lucide, matching the UI (a packages/ui dependency).
const LUCIDE = JSON.parse(fs.readFileSync(
  require.resolve('@iconify-json/lucide/icons.json', { paths: [path.resolve(__dirname, '../../../packages/ui')] }), 'utf8',
)).icons;

const col = TOKENS.color;
const K = {
  page: col.surface.page.value,
  t1: col.text.primary.value,
  t2: col.text.secondary.value,
  salmon: col.brand.salmon.value,
  salmonBg: col.accent.salmonSubtle.value,
  ring: TOKENS.effect.ring.stroke,
  cli: [col.component.cliIconFrom.value, col.component.cliIconTo.value, col.component.cliIconText.value],
  tileInk: col.component.letterIconText.value,
};
// Letter-tile palette and darkening rules: ICON_PALETTE and darken 18% in packages/shared/src/icons.ts.
const PALETTE = {
  violet: col.chart.series1.value,
  coral: col.chart.series2.value,
  teal: col.chart.series3.value,
  blue: col.status.info.value,
  salmon: col.brand.salmon.value,
};
const darken = (hex, amount = 0.18) =>
  '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount)).toString(16).padStart(2, '0')).join('').toUpperCase();

const W = 1500, H = 500;
// X web avatar circle including border: measured on a 600-wide column, center about (217, 494), radius 177; mobile is similar but slightly smaller.
const AVATAR = { cx: 217, cy: 494, r: 177 };
const n = (v) => fmt(v, 2);
// Polar coordinates around the avatar center; deg runs counterclockwise from the positive horizontal axis.
const polar = (r, deg) => [AVATAR.cx + r * Math.cos((deg * Math.PI) / 180), AVATAR.cy - r * Math.sin((deg * Math.PI) / 180)];

// Orbit spacing increases outward; outer rings cross the text region and fade progressively.
const RINGS = [258, 352, 458, 575, 705, 848, 1000];
const RING_FADE = [1, 1, 0.95, 0.85, 0.7, 0.55, 0.42];
// App tiles on orbits: the command-line tile is largest (Homebrew's roots); others use letter-tile colors and lucide icons.
const TILES = [
  { id: 't-cli', at: polar(RINGS[2], 47), size: 124, color: 'cli', icon: 'terminal', rot: -8 },
  { id: 't-music', at: polar(RINGS[1], 74), size: 92, color: 'violet', icon: 'music', rot: 9 },
  { id: 't-code', at: polar(RINGS[3], 29), size: 88, color: 'blue', icon: 'code-xml', rot: 8 },
  { id: 't-beer', at: polar(RINGS[0], 25), size: 70, color: 'salmon', icon: 'beer', rot: -10 },
  { id: 't-palette', at: polar(RINGS[2], 12), size: 66, color: 'teal', icon: 'palette', rot: 6 },
  { id: 't-play', at: polar(RINGS[0], 96), size: 62, color: 'coral', icon: 'play', rot: -12 },
];

// Convert coverGlow / heroGlow CSS radial gradients into SVG stops; transparent retains the preceding color to avoid gray fringes from interpolation toward black.
function glowStops(css) {
  let last = [0, 0, 0];
  return [...css.matchAll(/(?:rgba\(([^)]+)\)|transparent)\s+([\d.]+)%/g)].map((m) => {
    const v = m[1] ? m[1].split(',').map(Number) : [...last, 0];
    last = v.slice(0, 3);
    return `<stop offset="${Number(m[2]) / 100}" stop-color="rgb(${last.join(',')})" stop-opacity="${v[3]}"/>`;
  }).join('');
}

// Endpoints for a CSS 160-degree linear gradient in a square (objectBoundingBox).
const G160 = (() => {
  const t = (160 * Math.PI) / 180, dx = Math.sin(t), dy = -Math.cos(t), half = (Math.abs(dx) + Math.abs(dy)) / 2;
  return `x1="${fmt(0.5 - dx * half, 4)}" y1="${fmt(0.5 - dy * half, 4)}" x2="${fmt(0.5 + dx * half, 4)}" y2="${fmt(0.5 + dy * half, 4)}"`;
})();

// App tile: macOS superellipse (22.5% of side, matching app icons), 160-degree gradient, top highlight, and inset stroke (shadow.appIcon).
// Add shadow.floatIcon, scaled from the 118px icon in 08 section 8.13; icons are white with shadow.iconText.
function tile({ id, at, size, color, icon, rot }) {
  const [cx, cy] = at, s = size, x = cx - s / 2, y = cy - s / 2, k = s / 118;
  const [from, to, ink] = color === 'cli' ? K.cli : [PALETTE[color], darken(PALETTE[color]), K.tileInk];
  const body = squircle(x, y, s, s, s * 0.225, 0.6);
  const g = (s * 0.46) / 24;
  const defs =
    `<linearGradient id="${id}-bg" ${G160}><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>` +
    `<clipPath id="${id}-clip"><path d="${body}"/></clipPath>` +
    `<filter id="${id}-sh" x="-60%" y="-60%" width="220%" height="240%"><feDropShadow dx="0" dy="${n(18 * k)}" stdDeviation="${n(15 * k)}" flood-color="#000000" flood-opacity=".55"/></filter>` +
    `<filter id="${id}-ink" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${n(1.4 * k)}" stdDeviation="${n(1.4 * k)}" flood-color="#000000" flood-opacity=".3"/></filter>`;
  const el =
    `<g transform="rotate(${rot} ${n(cx)} ${n(cy)})">` +
    `<path d="${body}" fill="url(#${id}-bg)" filter="url(#${id}-sh)"/>` +
    `<rect x="${n(x)}" y="${n(y)}" width="${n(s)}" height="${n(s)}" fill="url(#hl)" clip-path="url(#${id}-clip)"/>` +
    `<path d="${body}" fill="none" stroke="#FFFFFF" stroke-opacity=".14" stroke-width="${n(Math.max(1, 1.2 * k))}"/>` +
    `<g filter="url(#${id}-ink)"><g transform="translate(${n(cx - 12 * g)} ${n(cy - 12 * g)}) scale(${fmt(g, 4)})">${LUCIDE[icon].body.replaceAll('currentColor', ink)}</g></g>` +
    `</g>`;
  return { defs, el };
}

// Text outline: align x to the ink's left edge (first-letter sidebearing can look misaligned); baseline sets the text baseline.
const measure = (key, size) => {
  const L = TEXT[key], k = size / L.upem;
  return { k, width: (L.ink[2] - L.ink[0]) * k, cap: L.capHeight * k };
};
function text(key, size, x, baseline, fill) {
  const L = TEXT[key], { k } = measure(key, size);
  return `<path fill="${fill}" d="${transformPath(L.d, k, x - L.ink[0] * k, baseline, 2)}"/>`;
}

// North Star decoration (like OnBadge star): set height and position its area centroid at (cx, cy).
const STAR_CENTROID = areaCentroid(MASTER.star);
function star(height, cx, cy, fill) {
  const [x0, y0, , y1] = MASTER.sBox, k = height / (y1 - y0);
  return { width: (MASTER.sBox[2] - x0) * k, el: `<path fill="${fill}" d="${transformPath(MASTER.star, k, cx - STAR_CENTROID[0] * k, cy - STAR_CENTROID[1] * k, 2)}"/>` };
}

function xBannerSvg() {
  // Use coverGlow for the main glow and heroGlow around the avatar; the avatar hides the center, leaving a bright rim.
  const glowR = 760, coreR = 330;
  const rings = RINGS.map((r, i) =>
    `<circle cx="${AVATAR.cx}" cy="${AVATAR.cy}" r="${r}" fill="none" stroke="${K.ring}" stroke-opacity="${RING_FADE[i]}" stroke-width="2.2" stroke-dasharray="4 12"/>`,
  ).join('');
  const tiles = TILES.map(tile);

  // Right-hand text: badge, two-line headline (hero tracking; salmon second line like the web hero), description; centered near the canvas midline.
  const x0 = 840, title = 72, sub = 26, eyebrow = 20;
  const pill = { top: 118, h: 40, pad: 16, gap: 9 };
  const eb = measure('x.eyebrow', eyebrow), st = star(17, 0, 0, '');
  const pillW = pill.pad + eb.width + pill.gap + st.width + pill.pad;
  const pillMid = pill.top + pill.h / 2;
  const base1 = pill.top + pill.h + 30 + measure('x.title1', title).cap;
  const base2 = base1 + 78, base3 = base2 + 54;

  // Overlay subtle grain: X converts headers to JPEG, and grain reduces banding in dark gradients.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<radialGradient id="glow" cx="${AVATAR.cx}" cy="${AVATAR.cy}" r="${glowR}" gradientUnits="userSpaceOnUse">${glowStops(TOKENS.effect.coverGlow.value)}</radialGradient>
<radialGradient id="core" cx="${AVATAR.cx}" cy="${AVATAR.cy}" r="${coreR}" gradientUnits="userSpaceOnUse">${glowStops(TOKENS.effect.heroGlow.value)}</radialGradient>
<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".12"/><stop offset=".5" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" result="t"/><feColorMatrix in="t" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .9 0"/></filter>
${tiles.map((t) => t.defs).join('\n')}
</defs>
<rect width="${W}" height="${H}" fill="${K.page}"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<rect width="${W}" height="${H}" fill="url(#core)"/>
${rings}
${tiles.map((t) => t.el).join('\n')}
<rect x="${x0}" y="${pill.top}" width="${n(pillW)}" height="${pill.h}" rx="11" fill="${K.salmonBg}"/>
${text('x.eyebrow', eyebrow, x0 + pill.pad, pillMid + eb.cap / 2, K.salmon)}${star(17, x0 + pillW - pill.pad - st.width / 2, pillMid, K.salmon).el}
${text('x.title1', title, x0, base1, K.t1)}
${text('x.title2', title, x0, base2, K.salmon)}
${text('x.sub', sub, x0, base3, K.t2)}
<rect width="${W}" height="${H}" filter="url(#grain)" opacity=".035"/>
</svg>
`;
}

// Preview: simulate the X web profile in light mode, overlaying the avatar at its measured position.
function previewSvg(banner) {
  const inner = banner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const ph = 760, { cx, cy, r } = AVATAR, border = 10;
  const k = ((r - border) * 2 * 0.5) / (MASTER.box[3] - MASTER.box[1]);
  const mx = cx - ((MASTER.box[0] + MASTER.box[2]) / 2) * k, my = cy - ((MASTER.box[1] + MASTER.box[3]) / 2) * k;
  const sh = B.markShapes(MASTER, k, mx, my, 'dark', 'pv', 2);
  const sc = [mx + ((MASTER.sBox[0] + MASTER.sBox[2]) / 2) * k, my + ((MASTER.sBox[1] + MASTER.sBox[3]) / 2) * k];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${ph}" viewBox="0 0 ${W} ${ph}">
<defs>${sh.defs}<radialGradient id="pv-glow" cx="${n(sc[0])}" cy="${n(sc[1])}" r="${n(r * 0.7)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.core[1]}" stop-opacity=".22"/><stop offset="1" stop-color="${C.core[1]}" stop-opacity="0"/></radialGradient></defs>
<rect width="${W}" height="${ph}" fill="#FFFFFF"/>
<svg x="0" y="0" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="#FFFFFF"/>
<circle cx="${cx}" cy="${cy}" r="${r - border}" fill="${C.iconBody}"/>
<circle cx="${cx}" cy="${cy}" r="${r - border}" fill="url(#pv-glow)"/>
${sh.body}
</svg>
`;
}

function buildSocial() {
  const banner = xBannerSvg();
  return [
    write('social/x-banner.svg', banner),
    write('social/x-banner.png', renderPng(banner, W)),
    write('social/x-banner-preview.png', renderPng(previewSvg(banner), W)),
  ];
}

module.exports = { xBannerSvg, buildSocial, AVATAR };

if (require.main === module) {
  for (const file of buildSocial()) console.log(path.relative(process.cwd(), file), fs.statSync(file).size);
}
