// OpenNavo logo geometry: N outline, North Star, path transforms, and macOS superellipse.
// Construct every shape in design units, then scale to the target canvas to keep proportions consistent.

const fmt = (n, dp = 3) => {
  const v = +(+n).toFixed(dp);
  return Object.is(v, -0) ? '0' : String(v);
};
const P = (p, dp) => `${fmt(p[0], dp)},${fmt(p[1], dp)}`;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => mul(a, 1 / len(a));

// Polygon to path; radii[i] is the corner radius at vertex i (0 means sharp).
function roundedPolygon(pts, radii) {
  const n = pts.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const V = pts[i], Pv = pts[(i - 1 + n) % n], Nx = pts[(i + 1) % n];
    let r = radii[i] || 0;
    const u1 = norm(sub(Pv, V)), u2 = norm(sub(Nx, V));
    const theta = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    if (r > 0 && theta > 1e-3 && Math.PI - theta > 1e-3) {
      let t = r / Math.tan(theta / 2);
      const maxT = Math.min(len(sub(Pv, V)), len(sub(Nx, V))) * 0.5;
      if (t > maxT) { t = maxT; r = t * Math.tan(theta / 2); }
      const T1 = add(V, mul(u1, t)), T2 = add(V, mul(u2, t));
      const cross = (V[0] - Pv[0]) * (Nx[1] - V[1]) - (V[1] - Pv[1]) * (Nx[0] - V[0]);
      d += `${i === 0 ? 'M' : 'L'}${P(T1)}A${fmt(r)},${fmt(r)} 0 0 ${cross > 0 ? 1 : 0} ${P(T2)}`;
    } else {
      d += `${i === 0 ? 'M' : 'L'}${P(V)}`;
    }
  }
  return d + 'Z';
}

// Horizontal diagonal width d that gives perpendicular stroke thickness t.
function diagWidth(W, H, t) {
  let lo = 0, hi = W;
  for (let k = 0; k < 80; k++) {
    const d = (lo + hi) / 2;
    if ((d * H) / Math.hypot(W - d, H) > t) hi = d; else lo = d;
  }
  return (lo + hi) / 2;
}

// N: left outer edge x=0, top y=0; W outer width, H height, s stem width, t diagonal thickness, yR right stem top (shortened for the star).
function nGlyph({ W, H, s, t, yR, r }) {
  const d = diagWidth(W, H, t);
  const atX = (p0, p1, x) => p0[1] + ((x - p0[0]) / (p1[0] - p0[0])) * (p1[1] - p0[1]);
  const yJr = atX([d, 0], [W, H], W - s); // Intersection of the diagonal's upper-right edge with the right stem's left edge.
  const yJl = atX([0, 0], [W - d, H], s); // Intersection of the diagonal's lower-left edge with the left stem's right edge.
  if (yR >= yJr) throw new Error(`Right stem top yR=${yR} must be above the diagonal intersection ${yJr.toFixed(2)}`);
  const v = [
    [[0, H], r.term], // Left stem, bottom left.
    [[0, 0], r.outer], // Outer top-left corner (the route's first turn).
    [[d, 0], r.apex], // Acute corner at the diagonal's top.
    [[W - s, yJr], r.inner], // Diagonal/right-stem intersection.
    [[W - s, yR], r.term], // Right stem, top left.
    [[W, yR], r.term], // Right stem, top right.
    [[W, H], r.outer], // Outer bottom-right corner (second turn).
    [[W - d, H], r.apex], // Acute corner at the diagonal's bottom.
    [[s, yJl], r.inner], // Diagonal/left-stem intersection.
    [[s, H], r.term], // Left stem, bottom right.
  ];
  return roundedPolygon(v.map((x) => x[0]), v.map((x) => x[1]));
}

// North Star: top, right, bottom, left rays (equal lateral rays); each edge is a concave cubic Bezier curve.
// pull: control-point distance toward the center as a fraction of the ray; smaller values make a fuller star.
function northStar(cx, cy, { top, side, bottom, pull }) {
  const tips = [[cx, cy - top], [cx + side, cy], [cx, cy + bottom], [cx - side, cy]];
  let d = `M${P(tips[0])}`;
  for (let i = 0; i < 4; i++) {
    const p0 = tips[i], p1 = tips[(i + 1) % 4];
    const c1 = [p0[0] + (cx - p0[0]) * pull, p0[1] + (cy - p0[1]) * pull];
    const c2 = [p1[0] + (cx - p1[0]) * pull, p1[1] + (cy - p1[1]) * pull];
    d += `C${P(c1)} ${P(c2)} ${P(p1)}`;
  }
  return d + 'Z';
}

// Generate N/star paths and their bounding boxes from parameters in design units.
function buildMark(p) {
  const n = nGlyph(p.n);
  const cx = p.n.W - p.n.s / 2; // Align the star's vertical axis with the right stem's centerline.
  const st = p.star;
  const star = northStar(cx, st.cy, st);
  const nBox = [0, 0, p.n.W, p.n.H];
  const sBox = [cx - st.side, st.cy - st.top, cx + st.side, st.cy + st.bottom];
  const box = [Math.min(nBox[0], sBox[0]), Math.min(nBox[1], sBox[1]), Math.max(nBox[2], sBox[2]), Math.max(nBox[3], sBox[3])];
  return { n, star, nBox, sBox, box, gap: p.n.yR - (st.cy + st.bottom) };
}

// Path transforms: absolute commands only (M L H V C S Q T A Z), sufficient for generated paths and fontTools output.
function tokenize(d) {
  const re = /([MLHVCSQTAZmlhvcsqtaz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  const out = [];
  let m;
  while ((m = re.exec(d))) out.push(m[1] ? m[1] : parseFloat(m[2]));
  return out;
}
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
function transformPath(d, k, tx, ty, dp = 3) {
  const tk = tokenize(d);
  let i = 0, cmd = null, out = '';
  const X = (x) => fmt(x * k + tx, dp), Y = (y) => fmt(y * k + ty, dp);
  while (i < tk.length) {
    if (typeof tk[i] === 'string') { cmd = tk[i++]; if (cmd !== cmd.toUpperCase()) throw new Error('Only absolute coordinates are supported: ' + cmd); if (cmd === 'Z') { out += 'Z'; continue; } }
    const a = tk.slice(i, i + ARITY[cmd]); i += ARITY[cmd];
    switch (cmd) {
      case 'M': case 'L': case 'T': out += `${cmd}${X(a[0])},${Y(a[1])}`; break;
      case 'H': out += `H${X(a[0])}`; break;
      case 'V': out += `V${Y(a[0])}`; break;
      case 'C': out += `C${X(a[0])},${Y(a[1])} ${X(a[2])},${Y(a[3])} ${X(a[4])},${Y(a[5])}`; break;
      case 'S': case 'Q': out += `${cmd}${X(a[0])},${Y(a[1])} ${X(a[2])},${Y(a[3])}`; break;
      case 'A': out += `A${fmt(a[0] * k, dp)},${fmt(a[1] * k, dp)} ${a[2]} ${a[3]} ${a[4]} ${X(a[5])},${Y(a[6])}`; break;
      default: throw new Error('Unknown command ' + cmd);
    }
    if (cmd === 'M') cmd = 'L';
  }
  return out;
}


// Flatten paths (absolute M L H V C Q A Z) into polygons for rasterizers that accept only polygons.
function flattenPath(d, { arcStep = 6, curveSegments = 24 } = {}) {
  const tk = tokenize(d);
  const polys = [];
  let cur = null, x = 0, y = 0, sx = 0, sy = 0, i = 0, cmd = null;
  const push = (px, py) => {
    const last = cur[cur.length - 1];
    if (!last || Math.hypot(last[0] - px, last[1] - py) > 1e-9) cur.push([px, py]);
    x = px; y = py;
  };
  while (i < tk.length) {
    if (typeof tk[i] === 'string') {
      cmd = tk[i++];
      if (cmd === 'Z') { if (cur && cur.length > 2) polys.push(cur); cur = null; x = sx; y = sy; continue; }
    }
    const a = tk.slice(i, i + ARITY[cmd]); i += ARITY[cmd];
    switch (cmd) {
      case 'M': cur = []; sx = a[0]; sy = a[1]; push(a[0], a[1]); cmd = 'L'; break;
      case 'L': push(a[0], a[1]); break;
      case 'H': push(a[0], y); break;
      case 'V': push(x, a[0]); break;
      case 'C': case 'Q': {
        const p0 = [x, y];
        for (let n = 1; n <= curveSegments; n++) {
          const t = n / curveSegments, u = 1 - t;
          if (cmd === 'C') push(u * u * u * p0[0] + 3 * u * u * t * a[0] + 3 * u * t * t * a[2] + t * t * t * a[4], u * u * u * p0[1] + 3 * u * u * t * a[1] + 3 * u * t * t * a[3] + t * t * t * a[5]);
          else push(u * u * p0[0] + 2 * u * t * a[0] + t * t * a[2], u * u * p0[1] + 2 * u * t * a[1] + t * t * a[3]);
        }
        break;
      }
      case 'A': {
        // SVG specification F.6.5: endpoint parameters to center parameters.
        let [rx, ry, rot, large, sweep, x2, y2] = a;
        const phi = (rot * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
        const dx = (x - x2) / 2, dy = (y - y2) / 2;
        const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
        rx = Math.abs(rx); ry = Math.abs(ry);
        const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
        if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
        const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
        const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
        const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
        const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
        const cx = cos * cxp - sin * cyp + (x + x2) / 2, cy = sin * cxp + cos * cyp + (y + y2) / 2;
        const ang = (ux, uy, vx, vy) => Math.sign(ux * vy - uy * vx || 1) * Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)))));
        const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
        let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
        if (!sweep && dt > 0) dt -= 2 * Math.PI;
        if (sweep && dt < 0) dt += 2 * Math.PI;
        const n = Math.max(2, Math.ceil(Math.abs((dt * 180) / Math.PI) / arcStep));
        for (let k = 1; k <= n; k++) {
          const t = t1 + (dt * k) / n;
          push(k === n ? x2 : cx + rx * cos * Math.cos(t) - ry * sin * Math.sin(t), k === n ? y2 : cy + rx * sin * Math.cos(t) + ry * cos * Math.sin(t));
        }
        break;
      }
      default: throw new Error('Flattening does not support command ' + cmd);
    }
  }
  if (cur && cur.length > 2) polys.push(cur);
  return polys;
}

// macOS-style continuous-curvature rounded rectangle (Figma corner smoothing algorithm).
function squircle(x, y, w, h, R, smoothing = 0.6) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const p = Math.min((1 + smoothing) * R, Math.min(w, h) / 2);
  const arcMeasure = 90 * (1 - smoothing);
  const arcLen = Math.sin(rad(arcMeasure / 2)) * R * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p34 = R * Math.tan(rad(alpha / 2));
  const beta = 45 * smoothing;
  const c = p34 * Math.cos(rad(beta));
  const dd = c * Math.tan(rad(beta));
  const b = (p - arcLen - c - dd) / 3, a = 2 * b;
  const n = (v) => fmt(v, 3);
  return [
    `M${n(x + w - p)},${n(y)}`,
    `c${n(a)},0 ${n(a + b)},0 ${n(a + b + c)},${n(dd)}`,
    `a${n(R)},${n(R)} 0 0 1 ${n(arcLen)},${n(arcLen)}`,
    `c${n(dd)},${n(c)} ${n(dd)},${n(b + c)} ${n(dd)},${n(a + b + c)}`,
    `L${n(x + w)},${n(y + h - p)}`,
    `c0,${n(a)} 0,${n(a + b)} ${n(-dd)},${n(a + b + c)}`,
    `a${n(R)},${n(R)} 0 0 1 ${n(-arcLen)},${n(arcLen)}`,
    `c${n(-c)},${n(dd)} ${n(-(b + c))},${n(dd)} ${n(-(a + b + c))},${n(dd)}`,
    `L${n(x + p)},${n(y + h)}`,
    `c${n(-a)},0 ${n(-(a + b))},0 ${n(-(a + b + c))},${n(-dd)}`,
    `a${n(R)},${n(R)} 0 0 1 ${n(-arcLen)},${n(-arcLen)}`,
    `c${n(-dd)},${n(-c)} ${n(-dd)},${n(-(b + c))} ${n(-dd)},${n(-(a + b + c))}`,
    `L${n(x)},${n(y + p)}`,
    `c0,${n(-a)} 0,${n(-(a + b))} ${n(dd)},${n(-(a + b + c))}`,
    `a${n(R)},${n(R)} 0 0 1 ${n(arcLen)},${n(-arcLen)}`,
    `c${n(c)},${n(-dd)} ${n(b + c)},${n(-dd)} ${n(a + b + c)},${n(-dd)}`,
    'Z',
  ].join('');
}

module.exports = { fmt, buildMark, transformPath, squircle, tokenize, flattenPath };
