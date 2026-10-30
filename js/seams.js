import { axisAngle, multiply, toMatrix3 } from "./quat.js?v=0.9.0";
import { photoOrientation } from "./stitch-settings.js?v=0.9.0";

// Seam finding. Near objects shift between photos because the phone moves a little, not just
// turns (parallax), so blending overlapping photos shows them twice, softly ("smudges").
// Instead, each spot of the sphere is taken from one photo, and the joins between photos are
// placed where neighboring photos agree (bare wall, floor) rather than through a table edge
// or a fan blade. Only a narrow strip along each join is blended.
//
// This works on a small map of the sphere (MAP_W × MAP_H), using the grayscale copies made for
// alignment. Choosing which photo to use where is a "graph cut" labeling (alpha-expansion):
// each photo in turn gets the chance to take over spots, and a minimum cut decides which ones,
// trading off two costs:
//  - data: prefer the photo whose center is closest (its sharpest, least distorted part);
//  - join: where two neighboring spots come from different photos, how much those two photos
//    disagree there.
// The result is one soft mask per photo (how much of it to use at each spot of the map), which
// the stitcher reads at full size.

export const MAP_W = 512; // 0.7° per spot
export const MAP_H = 256;

const DEG = Math.PI / 180;
const EDGE = 0.12; // spots this close to a photo's edge (0 = edge, 1 = center) can't use it
const DATA_WEIGHT = 8; // cost per spot of using a photo, per half field of view from its center
const JOIN_COST = 3; // extra cost per spot of join, so joins stay short where nothing differs
const FAR = 1000; // join cost where one of the two photos doesn't cover the spot
const CYCLES = 2; // rounds of giving every photo the chance to take over spots
const BAND = 50; // a photo may take over spots up to this much farther from its center (≈ 13°)
const BLUR = 1; // mask softening in spots (twice), so joins blend over about 1.5°
const NONE = 255;

// shots: [{ gray: { gray, width, height }, quaternion…, gain? }]; settings: the stitch settings
// (with vignette and yaw0Deg). Returns one Uint8Array mask per photo (MAP_W × MAP_H, bottom row
// first, 255 = use fully), or null for a photo that isn't used anywhere.
export async function findSeams(shots, settings, onProgress) {
  const n = shots.length;
  if (n > NONE) throw new Error("Too many photos for seam finding.");
  const size = MAP_W * MAP_H;
  const { cost, lum } = projectPhotos(shots, settings);

  // Start from the nearest photo center everywhere.
  const labels = new Uint8Array(size).fill(NONE);
  for (let p = 0; p < size; p++) {
    let best = NONE;
    for (let i = 0; i < n; i++) if (cost[i][p] < NONE && (best === NONE || cost[i][p] < cost[best][p])) best = i;
    labels[p] = best;
  }

  const join = (a, b, p, q) => {
    if (a === b) return 0;
    if (a === NONE || b === NONE) return FAR;
    if (cost[a][q] === NONE || cost[b][p] === NONE) return FAR;
    return Math.abs(lum[a][p] - lum[b][p]) + Math.abs(lum[a][q] - lum[b][q]) + JOIN_COST;
  };
  const data = (i, p) => (DATA_WEIGHT * cost[i][p]) / 100;

  for (let cycle = 0; cycle < CYCLES; cycle++) {
    for (let alpha = 0; alpha < n; alpha++) {
      expand(alpha, labels, cost, data, join);
      onProgress?.((cycle * n + alpha + 1) / (CYCLES * n));
      await new Promise((resolve) => setTimeout(resolve)); // keep the page responsive
    }
  }
  return { labels, masks: softMasks(labels, n) };
}

// For every photo: the data cost at each spot of the map (its distance from the photo's center,
// in hundredths of half the narrow field of view; NONE where it can't be used), and its
// brightness there (gray copy with the photo's brightness and vignetting corrections).
function projectPhotos(shots, settings) {
  const offset = multiply(
    multiply(axisAngle([0, 1, 0], settings.yawOffsetDeg), axisAngle([1, 0, 0], settings.pitchOffsetDeg)),
    axisAngle([0, 0, 1], settings.rollOffsetDeg),
  );
  const tanHalf = Math.tan((settings.fovLongDeg * Math.PI) / 360);
  const yaw0 = (settings.yaw0Deg ?? 0) * DEG;
  const vignette = settings.matchExposure && settings.vignette ? (settings.vignette[0] + settings.vignette[1] + settings.vignette[2]) / 3 : 0;
  const dirs = new Float32Array(MAP_W * MAP_H * 3);
  for (let y = 0; y < MAP_H; y++) {
    const pitch = ((y + 0.5) / MAP_H - 0.5) * Math.PI; // row 0 is the bottom, as in the stitcher
    for (let x = 0; x < MAP_W; x++) {
      const yaw = yaw0 + ((x + 0.5) / MAP_W - 0.5) * 2 * Math.PI;
      const k = (y * MAP_W + x) * 3;
      dirs[k] = Math.sin(yaw) * Math.cos(pitch);
      dirs[k + 1] = Math.cos(yaw) * Math.cos(pitch);
      dirs[k + 2] = Math.sin(pitch);
    }
  }
  const cost = [];
  const lum = [];
  for (const shot of shots) {
    const { gray, width, height } = shot.gray;
    const m = toMatrix3(multiply(photoOrientation(shot, settings), offset));
    const f = Math.max(width, height) / 2 / tanHalf;
    const halfNarrow = Math.atan((0.5 * Math.min(width, height)) / f);
    const g = shot.gain && settings.matchExposure ? 0.299 * shot.gain[0] + 0.587 * shot.gain[1] + 0.114 * shot.gain[2] : 1;
    const c = new Uint8Array(MAP_W * MAP_H).fill(NONE);
    const l = new Uint8Array(MAP_W * MAP_H);
    for (let p = 0; p < MAP_W * MAP_H; p++) {
      const dx = dirs[p * 3];
      const dy = dirs[p * 3 + 1];
      const dz = dirs[p * 3 + 2];
      // m is camera→world (row-major), so its transpose takes world → camera.
      const vz = m[2] * dx + m[5] * dy + m[8] * dz;
      if (vz > -1e-3) continue;
      const vx = m[0] * dx + m[3] * dy + m[6] * dz;
      const vy = m[1] * dx + m[4] * dy + m[7] * dz;
      const u = ((vx / -vz) * f) / width + 0.5;
      const v = 0.5 - ((vy / -vz) * f) / height; // image rows run top to bottom
      if (Math.min(u, 1 - u, v, 1 - v) * 2 < EDGE) continue;
      const angle = Math.acos(Math.min(1, -vz / Math.hypot(vx, vy, vz))) / halfNarrow;
      c[p] = Math.min(NONE - 1, Math.round(angle * 100));
      // Bilinear sample of the gray copy.
      const sx = u * width - 0.5;
      const sy = v * height - 0.5;
      const x0 = Math.max(0, Math.min(width - 2, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(height - 2, Math.floor(sy)));
      const fx = Math.min(1, Math.max(0, sx - x0));
      const fy = Math.min(1, Math.max(0, sy - y0));
      const i = y0 * width + x0;
      const top = gray[i] + (gray[i + 1] - gray[i]) * fx;
      const bottom = gray[i + width] + (gray[i + width + 1] - gray[i + width]) * fx;
      const r2 = ((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2;
      l[p] = Math.min(255, (top + (bottom - top) * fy) * g * Math.exp(vignette * r2));
    }
    cost.push(c);
    lum.push(l);
  }
  return { cost, lum };
}

// One alpha-expansion move: every spot photo `alpha` can cover either keeps its photo or
// switches to alpha, whichever gives the lowest total cost (found exactly by a minimum cut).
function expand(alpha, labels, cost, data, join) {
  const size = MAP_W * MAP_H;
  const node = new Int32Array(size).fill(-1);
  const spots = [];
  for (let p = 0; p < size; p++) {
    // Only spots where alpha is a real candidate: not much farther from its center than the
    // current photo is from its own. Joins never move deep into another photo's middle.
    if (cost[alpha][p] !== NONE && cost[alpha][p] <= cost[labels[p]][p] + BAND) {
      node[p] = spots.length;
      spots.push(p);
    }
  }
  const count = spots.length;
  if (count === 0) return;
  const keep = new Float64Array(count); // cost if the spot keeps its photo
  const take = new Float64Array(count); // cost if it switches to alpha
  const graph = new Graph(count, count * 2);
  for (let k = 0; k < count; k++) {
    const p = spots[k];
    keep[k] += data(labels[p], p);
    take[k] += data(alpha, p);
  }
  // Each pair of neighboring spots once: right (wrapping around) and up.
  for (let k = 0; k < count; k++) {
    const p = spots[k];
    const x = p % MAP_W;
    const y = (p - x) / MAP_W;
    pair(p, y * MAP_W + ((x + 1) % MAP_W));
    if (y + 1 < MAP_H) pair(p, p + MAP_W);
  }
  // Neighbors whose other spot alpha can't cover only need the in-graph side counted, from below/left.
  for (let k = 0; k < count; k++) {
    const p = spots[k];
    const x = p % MAP_W;
    const y = (p - x) / MAP_W;
    const left = y * MAP_W + ((x + MAP_W - 1) % MAP_W);
    if (node[left] < 0) fixedNeighbor(k, p, left);
    if (y > 0 && node[p - MAP_W] < 0) fixedNeighbor(k, p, p - MAP_W);
  }

  function pair(p, q) {
    const kq = node[q];
    const k = node[p];
    if (kq < 0) {
      fixedNeighbor(k, p, q);
      return;
    }
    const lp = labels[p];
    const lq = labels[q];
    let a = join(lp, lq, p, q); // both keep
    const b = join(lp, alpha, p, q); // p keeps, q switches
    const c = join(alpha, lq, p, q); // p switches, q keeps
    if (a > b + c) a = b + c; // keeps the move solvable by a cut (standard truncation)
    take[k] += c - a;
    take[kq] -= c;
    graph.addEdge(k, kq, b + c - a);
  }

  function fixedNeighbor(k, p, q) {
    keep[k] += join(labels[p], labels[q], p, q);
    take[k] += join(alpha, labels[q], p, q);
  }

  for (let k = 0; k < count; k++) {
    const low = Math.min(keep[k], take[k]);
    graph.setTerminals(k, take[k] - low, keep[k] - low);
  }
  graph.maxflow();
  for (let k = 0; k < count; k++) if (!graph.onSourceSide(k)) labels[spots[k]] = alpha;
}

// Minimum cut by Dinic's max-flow. A node on the source side keeps its photo; one on the sink
// side switches. setTerminals(k, toSource, toSink): the cost paid if k ends up on the sink side,
// and if it ends up on the source side.
class Graph {
  constructor(nodes, edges) {
    this.n = nodes + 2;
    this.s = nodes;
    this.t = nodes + 1;
    const max = 2 * (2 * nodes + edges);
    this.head = new Int32Array(this.n).fill(-1);
    this.next = new Int32Array(max);
    this.to = new Int32Array(max);
    this.cap = new Float64Array(max);
    this.m = 0;
  }

  addEdge(a, b, cap) {
    if (cap <= 1e-9) return;
    const e = this.m;
    this.to[e] = b;
    this.cap[e] = cap;
    this.next[e] = this.head[a];
    this.head[a] = e;
    this.to[e + 1] = a;
    this.cap[e + 1] = 0;
    this.next[e + 1] = this.head[b];
    this.head[b] = e + 1;
    this.m += 2;
  }

  setTerminals(k, toSource, toSink) {
    this.addEdge(this.s, k, toSource);
    this.addEdge(k, this.t, toSink);
  }

  maxflow() {
    const { n, s, t, head, next, to, cap } = this;
    const level = new Int32Array(n);
    const it = new Int32Array(n);
    const queue = new Int32Array(n);
    const path = new Int32Array(n);
    for (;;) {
      level.fill(-1);
      level[s] = 0;
      let qh = 0;
      let qt = 0;
      queue[qt++] = s;
      while (qh < qt) {
        const v = queue[qh++];
        for (let e = head[v]; e !== -1; e = next[e]) {
          if (cap[e] > 1e-9 && level[to[e]] < 0) {
            level[to[e]] = level[v] + 1;
            queue[qt++] = to[e];
          }
        }
      }
      if (level[t] < 0) break;
      it.set(head);
      // Push flow along shortest paths until none is left (blocking flow).
      let depth = 0;
      let v = s;
      for (;;) {
        if (v === t) {
          let f = Infinity;
          for (let k = 0; k < depth; k++) f = Math.min(f, cap[path[k]]);
          let cut = depth;
          for (let k = 0; k < depth; k++) {
            cap[path[k]] -= f;
            cap[path[k] ^ 1] += f;
            if (cut === depth && cap[path[k]] <= 1e-9) cut = k;
          }
          depth = cut;
          v = depth === 0 ? s : to[path[depth - 1]];
          continue;
        }
        let e = it[v];
        while (e !== -1 && !(cap[e] > 1e-9 && level[to[e]] === level[v] + 1)) e = next[e];
        it[v] = e;
        if (e !== -1) {
          path[depth++] = e;
          v = to[e];
          continue;
        }
        if (depth === 0) break; // nothing more from the source
        level[v] = -1; // dead end
        const back = path[--depth];
        v = to[back ^ 1];
        it[v] = next[it[v]];
      }
    }
    // Nodes still reachable from the source in what's left of the graph.
    this.reached = new Uint8Array(n);
    let qh = 0;
    let qt = 0;
    queue[qt++] = s;
    this.reached[s] = 1;
    while (qh < qt) {
      const v = queue[qh++];
      for (let e = head[v]; e !== -1; e = next[e]) {
        if (cap[e] > 1e-9 && !this.reached[to[e]]) {
          this.reached[to[e]] = 1;
          queue[qt++] = to[e];
        }
      }
    }
  }

  onSourceSide(k) {
    return this.reached[k] === 1;
  }
}

// One mask per photo: 255 where it was chosen, softened across joins so they blend over ~1°.
function softMasks(labels, n) {
  const size = MAP_W * MAP_H;
  const masks = [];
  const a = new Float32Array(size);
  const b = new Float32Array(size);
  for (let i = 0; i < n; i++) {
    let used = false;
    for (let p = 0; p < size; p++) {
      a[p] = labels[p] === i ? 1 : 0;
      if (a[p]) used = true;
    }
    if (!used) {
      masks.push(null);
      continue;
    }
    for (let pass = 0; pass < 2; pass++) {
      boxBlur(a, b, true);
      boxBlur(b, a, false);
    }
    const mask = new Uint8Array(size);
    for (let p = 0; p < size; p++) mask[p] = Math.round(a[p] * 255);
    masks.push(mask);
  }
  return masks;
}

// Box blur of radius BLUR along rows (wrapping around, horizontal) or columns.
function boxBlur(src, dst, horizontal) {
  const r = BLUR;
  const norm = 1 / (2 * r + 1);
  if (horizontal) {
    for (let y = 0; y < MAP_H; y++) {
      const row = y * MAP_W;
      let sum = 0;
      for (let d = -r; d <= r; d++) sum += src[row + ((d + MAP_W) % MAP_W)];
      for (let x = 0; x < MAP_W; x++) {
        dst[row + x] = sum * norm;
        sum += src[row + ((x + r + 1) % MAP_W)] - src[row + ((x - r + MAP_W) % MAP_W)];
      }
    }
  } else {
    for (let x = 0; x < MAP_W; x++) {
      for (let y = 0; y < MAP_H; y++) {
        let sum = 0;
        let count = 0;
        for (let d = Math.max(0, y - r); d <= Math.min(MAP_H - 1, y + r); d++) {
          sum += src[d * MAP_W + x];
          count++;
        }
        dst[y * MAP_W + x] = sum / count;
      }
    }
  }
}
