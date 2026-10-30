import { axisAngle, multiply, toMatrix3 } from "./quat.js?v=0.9.0";

// Refines each photo's orientation so overlapping photos line up (a "rotation bundle
// adjustment"). The phone's sensors put each photo within a degree or two of where it
// belongs; this closes the rest of the gap using the pictures themselves:
//  1. For each pair of overlapping photos, small patches of their shared area are rendered
//     from both photos onto the same flat grid and slid against each other to find where
//     they match best (normalized cross-correlation).
//  2. Each match says "this point in photo i shows the same thing as that point in photo j".
//     A least-squares solve then turns every photo slightly so that all matches agree.
//  3. Repeat a few times with tighter searches, ignoring matches that disagree with the rest
//     (moving people, objects so close that they shift between photos).

export const ALIGN_SIZE = 800; // long side of the grayscale copies used for matching

const DEG = Math.PI / 180;
const MAX_PAIR_ANGLE = 60 * DEG; // photo centers further apart than this barely overlap
// Candidate patch centers around the middle of each overlap: along the seam and across it.
const ALONG = [-30, -24, -18, -12, -6, 0, 6, 12, 18, 24, 30].map((a) => Math.tan(a * DEG));
const ACROSS = [-12, -6, 0, 6, 12].map((a) => Math.tan(a * DEG));
const MAX_TILES = 6; // patches used per pair: the most detailed candidates…
const MIN_SPACING = 8 * DEG; // …that are at least this far apart
const COARSE = { scale: 0.2 * DEG, size: 32 }; // patch: 32 px at 0.2°/px ≈ 6.4°
const FINE = { scale: 0.1 * DEG, size: 40, radius: 3 }; // then 40 px at 0.1°/px, ±0.3°
// Per round: how far the coarse search looks (in coarse pixels) and how big a disagreement
// still counts fully in the solve.
const ROUNDS = [
  { radius: 20, robustDeg: 1.5 }, // ±4°
  { radius: 12, robustDeg: 0.8 },
  { radius: 6, robustDeg: 0.4 },
  { radius: 3, robustDeg: 0.2 },
  { radius: 3, robustDeg: 0.15 },
];
const MIN_SCORE = 0.7; // matches weaker than this are ignored
const MIN_CONTRAST = 4; // patches flatter than this (e.g. bare walls) can't be matched
const PRIOR = 1; // weak pull toward the sensor orientation; also keeps the whole sphere level

// Makes the grayscale copy of a photo used for matching: { gray, width, height }.
export function grayCopy(image) {
  const scale = Math.min(1, ALIGN_SIZE / Math.max(image.width, image.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8ClampedArray(canvas.width * canvas.height); // 1 byte per pixel: 4× less than floats
  for (let i = 0; i < gray.length; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const { width, height } = canvas;
  canvas.width = canvas.height = 0; // free it now
  return { gray, width, height };
}

// photos: [{ gray: grayCopy(...), quaternion }] with the starting (sensor) orientations.
// settings: the stitch settings (field of view and camera offsets).
// Returns { quaternions: refined orientation per photo, matches, beforeDeg, afterDeg }.
export async function refineOrientations(photos, settings, onProgress) {
  const n = photos.length;
  const offset = multiply(
    multiply(axisAngle([0, 1, 0], settings.yawOffsetDeg), axisAngle([1, 0, 0], settings.pitchOffsetDeg)),
    axisAngle([0, 0, 1], settings.rollOffsetDeg),
  );
  const tanHalf = Math.tan((settings.fovLongDeg * Math.PI) / 360);
  let quats = photos.map((p) => p.quaternion);
  let beforeDeg = null;
  let afterDeg = null;
  let matchCount = 0;

  for (const [round, { radius, robustDeg }] of ROUNDS.entries()) {
    onProgress?.(round, ROUNDS.length);
    await new Promise((r) => setTimeout(r)); // let the page update
    const cams = photos.map((p, i) => camera(p.gray, multiply(quats[i], offset), tanHalf));
    const matches = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (angle(cams[i].axis, cams[j].axis) > MAX_PAIR_ANGLE) continue;
        for (const m of matchPair(cams[i], cams[j], radius)) matches.push({ i, j, ...m });
      }
    }
    matchCount = matches.length;
    if (matches.length === 0) break;
    const errors = matches.map((m) => norm(sub(m.a, m.b)) / DEG);
    if (round === 0) beforeDeg = median(errors);

    const omega = solveRotations(n, matches, robustDeg * DEG);
    quats = quats.map((q, i) => {
      const w = omega.slice(i * 3, i * 3 + 3);
      const len = norm(w);
      return len < 1e-12 ? q : multiply(axisAngle(scale(w, 1 / len), len / DEG), q);
    });
    afterDeg = median(matches.map((m) => norm(residual(m, omega)) / DEG));
  }
  return { quaternions: quats, matches: matchCount, beforeDeg, afterDeg };
}

// Everything needed to look things up in one photo.
function camera({ gray, width, height }, q, tanHalf) {
  const m = toMatrix3(q); // camera → world, row-major
  return {
    m,
    gray,
    width,
    height,
    f: Math.max(width, height) / 2 / tanHalf,
    axis: [-m[2], -m[5], -m[8]], // world direction the camera looks
  };
}

// Finds matching points between two overlapping photos: [{ a, b }], where a and b are world
// directions (by each photo's current orientation) of the same thing.
function matchPair(ci, cj, coarseRadius) {
  const mid = normalize(add(ci.axis, cj.axis));
  const along = normalize(cross(ci.axis, cj.axis)); // runs along the seam between them
  const across = cross(along, mid);
  const reach = (COARSE.size / 2 + coarseRadius) * COARSE.scale; // half-width of the coarse search area

  // Candidate spots whose whole search area lies inside both photos, most detailed first.
  const candidates = [];
  for (const a of ALONG) {
    for (const b of ACROSS) {
      const c = normalize(add(mid, add(scale(along, a), scale(across, b))));
      const [e1, e2] = tangentBasis(c);
      if (!fits(ci, c, e1, e2, reach) || !fits(cj, c, e1, e2, reach)) continue;
      const tile = renderTile(ci, c, e1, e2, COARSE.scale, COARSE.size, 0, 0);
      const detail = tile ? contrast(tile) : 0;
      if (detail >= MIN_CONTRAST) candidates.push({ c, e1, e2, tile, detail });
    }
  }
  candidates.sort((p, q) => q.detail - p.detail);
  const picked = [];
  for (const cand of candidates) {
    if (picked.length === MAX_TILES) break;
    if (picked.every((p) => angle(p.c, cand.c) >= MIN_SPACING)) picked.push(cand);
  }

  const found = [];
  for (const { c, e1, e2, tile: a0 } of picked) {
    // Coarse: wide search at low resolution.
    const b0 = renderTile(cj, c, e1, e2, COARSE.scale, COARSE.size + 2 * coarseRadius, 0, 0);
    if (!b0) continue;
    const coarse = bestShift(a0, COARSE.size, b0, coarseRadius);
    if (coarse.score < MIN_SCORE - 0.1) continue;
    let tx = coarse.dx * COARSE.scale;
    let ty = -coarse.dy * COARSE.scale; // tile rows run downward, tangent y runs up

    // Fine: small search at full resolution around the coarse result.
    const a1 = renderTile(ci, c, e1, e2, FINE.scale, FINE.size, 0, 0);
    const b1 = renderTile(cj, c, e1, e2, FINE.scale, FINE.size + 2 * FINE.radius, tx, ty);
    if (!a1 || !b1) continue;
    const fine = bestShift(a1, FINE.size, b1, FINE.radius);
    if (fine.score < MIN_SCORE) continue;
    tx += fine.dx * FINE.scale;
    ty -= fine.dy * FINE.scale;
    found.push({ a: c, b: normalize(add(c, add(scale(e1, tx), scale(e2, ty)))) });
  }
  return found;
}

// Whether a square of half-width reach (radians) around c lies inside the photo.
function fits(cam, c, e1, e2, reach) {
  const { m, f, width, height } = cam;
  for (const sx of [-reach, reach]) {
    for (const sy of [-reach, reach]) {
      const d = add(c, add(scale(e1, sx), scale(e2, sy)));
      const vz = m[2] * d[0] + m[5] * d[1] + m[8] * d[2];
      if (vz > -1e-6) return false;
      const u = ((m[0] * d[0] + m[3] * d[1] + m[6] * d[2]) / -vz) * f + width / 2;
      const v = height / 2 - ((m[1] * d[0] + m[4] * d[1] + m[7] * d[2]) / -vz) * f;
      if (u < 2 || v < 2 || u > width - 2 || v > height - 2) return false;
    }
  }
  return true;
}

// Renders a square patch of a photo onto the flat grid that touches the sphere at c.
// (x0, y0) shifts the patch along the grid (radians). Returns null if it leaves the photo.
function renderTile(cam, c, e1, e2, step, size, x0, y0) {
  const { m, f, width, height, gray } = cam;
  const out = new Float32Array(size * size);
  const half = (size - 1) / 2;
  let k = 0;
  for (let py = 0; py < size; py++) {
    const y = (half - py) * step + y0;
    for (let px = 0; px < size; px++) {
      const x = (px - half) * step + x0;
      const dx = c[0] + x * e1[0] + y * e2[0];
      const dy = c[1] + x * e1[1] + y * e2[1];
      const dz = c[2] + x * e1[2] + y * e2[2];
      // world → camera is the transpose of m
      const vz = m[2] * dx + m[5] * dy + m[8] * dz;
      if (vz > -1e-6) return null;
      const u = ((m[0] * dx + m[3] * dy + m[6] * dz) / -vz) * f + width / 2 - 0.5;
      const v = height / 2 - ((m[1] * dx + m[4] * dy + m[7] * dz) / -vz) * f - 0.5;
      if (u < 0 || v < 0 || u >= width - 1 || v >= height - 1) return null;
      const u0 = u | 0;
      const v0 = v | 0;
      const fu = u - u0;
      const fv = v - v0;
      const i = v0 * width + u0;
      out[k++] =
        (gray[i] * (1 - fu) + gray[i + 1] * fu) * (1 - fv) + (gray[i + width] * (1 - fu) + gray[i + width + 1] * fu) * fv;
    }
  }
  return out;
}

// Slides patch a (size × size) over b ((size + 2r)²) and returns the best offset (sub-pixel)
// and its normalized cross-correlation score (1 = perfect match).
function bestShift(a, size, b, r) {
  const n = size * size;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += a[i];
  mean /= n;
  const az = new Float32Array(n);
  let aa = 0;
  for (let i = 0; i < n; i++) {
    az[i] = a[i] - mean;
    aa += az[i] * az[i];
  }
  const span = 2 * r + 1;
  const bw = size + 2 * r;
  const scores = new Float32Array(span * span);
  let best = 0;
  for (let oy = 0; oy < span; oy++) {
    for (let ox = 0; ox < span; ox++) {
      let sb = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = 0; y < size; y++) {
        const rowB = (oy + y) * bw + ox;
        const rowA = y * size;
        for (let x = 0; x < size; x++) {
          const vb = b[rowB + x];
          sb += vb;
          sbb += vb * vb;
          sab += az[rowA + x] * vb;
        }
      }
      const varB = sbb - (sb * sb) / n;
      const s = varB > 1e-6 && aa > 1e-6 ? sab / Math.sqrt(aa * varB) : -1;
      scores[oy * span + ox] = s;
      if (s > scores[best]) best = oy * span + ox;
    }
  }
  const bx = best % span;
  const by = (best / span) | 0;
  const at = (x, y) => scores[y * span + x];
  const peak = (lo, mid, hi) => {
    const d = lo - 2 * mid + hi;
    return d < 0 ? Math.max(-0.5, Math.min(0.5, (lo - hi) / (2 * d))) : 0;
  };
  const fx = bx > 0 && bx < span - 1 ? peak(at(bx - 1, by), at(bx, by), at(bx + 1, by)) : 0;
  const fy = by > 0 && by < span - 1 ? peak(at(bx, by - 1), at(bx, by), at(bx, by + 1)) : 0;
  // A best match on the edge of the search area probably means the real one is outside it.
  const onEdge = bx === 0 || by === 0 || bx === span - 1 || by === span - 1;
  return { dx: bx + fx - r, dy: by + fy - r, score: onEdge ? -1 : at(bx, by) };
}

// Small rotations (one 3-vector per photo, in the world frame) that best make every match's
// two directions agree, by least squares. Matches that still disagree by much more than
// robustRad after a solve get less weight, and the solve is repeated.
function solveRotations(n, matches, robustRad) {
  const size = 3 * n;
  let weights = matches.map(() => 1);
  let omega = new Float64Array(size);
  for (let pass = 0; pass < 4; pass++) {
    const N = Array.from({ length: size }, () => new Float64Array(size));
    const rhs = new Float64Array(size);
    matches.forEach((m, k) => {
      const h = weights[k];
      const w = normalize(add(m.a, m.b));
      const e = sub(m.a, m.b);
      const we = cross(w, e);
      // Block (I − w wᵀ) couples the two photos' rotations.
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const v = h * ((r === c ? 1 : 0) - w[r] * w[c]);
          N[m.i * 3 + r][m.i * 3 + c] += v;
          N[m.j * 3 + r][m.j * 3 + c] += v;
          N[m.i * 3 + r][m.j * 3 + c] -= v;
          N[m.j * 3 + r][m.i * 3 + c] -= v;
        }
        rhs[m.i * 3 + r] -= h * we[r];
        rhs[m.j * 3 + r] += h * we[r];
      }
    });
    for (let k = 0; k < size; k++) N[k][k] += PRIOR;
    omega = solve(N, rhs);
    weights = matches.map((m) => {
      const r = norm(residual(m, omega));
      return r <= robustRad ? 1 : robustRad / r;
    });
  }
  return omega;
}

// How far apart a match's two directions are after applying the small rotations.
function residual(m, omega) {
  const wi = omega.slice(m.i * 3, m.i * 3 + 3);
  const wj = omega.slice(m.j * 3, m.j * 3 + 3);
  return sub(add(m.a, cross(wi, m.a)), add(m.b, cross(wj, m.b)));
}

function tangentBasis(c) {
  const ref = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = normalize(cross(ref, c));
  return [e1, cross(c, e1)];
}

function contrast(tile) {
  let s = 0;
  let ss = 0;
  for (const v of tile) {
    s += v;
    ss += v * v;
  }
  const mean = s / tile.length;
  return Math.sqrt(Math.max(0, ss / tile.length - mean * mean));
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => {
    const r = new Float64Array(n + 1);
    r.set(row);
    r[n] = b[i];
    return r;
  });
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= factor * M[col][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => scale(a, 1 / norm(a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
