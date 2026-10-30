// A simple 3D test room with exactly known depth, drawn as a 360° (equirectangular) picture.
// Like Sphere Cam's synthetic test sphere, it lets depth and the walking viewer be checked
// against the truth with no phone: if the test room looks right but a real sphere doesn't,
// the problem is the depth estimate, not the viewer.
//
// No browser features are used here, so it also runs in Node for quick checks.
//
// World frame (same as Sphere Cam's quat.js): Z up, Y straight ahead ("FRONT", the center of the
// picture), X to the right. Units are meters; the floor is at z = 0.

export const EYE_HEIGHT = 1.5; // phone height above the floor while capturing
export const EYE = [0, 0, EYE_HEIGHT];

const WALL_HEIGHT = 2.6;
const DOOR = { halfWidth: 0.45, height: 2.05 };
const WALL_THICKNESS = 0.15;
const FRONT = 3; // front wall of the main room (with the doorway)
const LIGHT = [0.4, 0.6, 2.4];

// Surface patterns. Each returns an [r, g, b] color (0–1) for a point on the surface.
const tiles = (p) => {
  // 50 cm floor tiles in two tones, with thin grout lines: easy to judge distance and flatness.
  const fx = p[0] / 0.5;
  const fy = p[1] / 0.5;
  const grout = Math.min(frac(fx), 1 - frac(fx), frac(fy), 1 - frac(fy)) < 0.02;
  if (grout) return [0.32, 0.3, 0.28];
  return (Math.floor(fx) + Math.floor(fy)) & 1 ? [0.78, 0.7, 0.58] : [0.55, 0.45, 0.35];
};
const wall = (base) => (p, n) => {
  // Faint lines every 50 cm on the wall.
  const [a, b] = n[0] ? [p[1], p[2]] : [p[0], p[2]];
  const line = Math.min(frac(a / 0.5), 1 - frac(a / 0.5), frac(b / 0.5), 1 - frac(b / 0.5)) < 0.012;
  return line ? base.map((c) => c * 0.82) : base;
};
const checker = (c1, c2, size) => (p, n) => {
  const [a, b] = n[0] ? [p[1], p[2]] : n[1] ? [p[0], p[2]] : [p[0], p[1]];
  return (Math.floor(a / size) + Math.floor(b / size)) & 1 ? c1 : c2;
};
const plain = (c) => () => c;
const wood = (p, n) => {
  const along = n[2] ? p[0] : p[2];
  const grain = 0.5 + 0.5 * Math.sin(along * 40 + Math.sin(p[1] * 7) * 2);
  return [0.45 + 0.08 * grain, 0.28 + 0.05 * grain, 0.16];
};

// The scene is a list of axis-aligned rectangles. A rectangle lies in the plane
// coordinate[axis] = at and covers [lo, hi] in the other two coordinates (in x, y, z order).
// facing (+1 or −1) is the side it can be seen from.
const AXES = [[1, 2], [0, 2], [0, 1]];
const rects = [];

function rect(axis, at, lo, hi, facing, pattern) {
  const normal = [0, 0, 0];
  normal[axis] = facing;
  rects.push({ axis, at, lo, hi, normal, pattern, others: AXES[axis] });
}

// A solid box seen from outside.
function box(min, max, pattern) {
  for (let axis = 0; axis < 3; axis++) {
    const [a, b] = AXES[axis];
    const lo = [min[a], min[b]];
    const hi = [max[a], max[b]];
    rect(axis, min[axis], lo, hi, -1, pattern);
    rect(axis, max[axis], lo, hi, +1, pattern);
  }
}

// Main room: x −2.5…2.5, y −2…3. Back room through the doorway: x −1.6…1.6, y 3.15…6.5.
const BACK_ROOM = { x: 1.6, y0: FRONT + WALL_THICKNESS, y1: 6.5 };
rect(2, 0, [-2.5, -2], [2.5, BACK_ROOM.y1], +1, tiles); // floor (both rooms)
rect(2, WALL_HEIGHT, [-2.5, -2], [2.5, BACK_ROOM.y1], -1, plain([0.86, 0.86, 0.84])); // ceiling
rect(0, -2.5, [-2, 0], [FRONT, WALL_HEIGHT], +1, wall([0.62, 0.72, 0.82])); // left wall, blue
rect(0, 2.5, [-2, 0], [FRONT, WALL_HEIGHT], -1, wall([0.84, 0.72, 0.56])); // right wall, sand
rect(1, -2, [-2.5, 0], [2.5, WALL_HEIGHT], +1, wall([0.7, 0.8, 0.62])); // back wall, green
// Front wall with a doorway in the middle.
const frontWall = wall([0.88, 0.85, 0.78]);
rect(1, FRONT, [-2.5, 0], [-DOOR.halfWidth, WALL_HEIGHT], -1, frontWall);
rect(1, FRONT, [DOOR.halfWidth, 0], [2.5, WALL_HEIGHT], -1, frontWall);
rect(1, FRONT, [-DOOR.halfWidth, DOOR.height], [DOOR.halfWidth, WALL_HEIGHT], -1, frontWall);
// Door frame (the wall's thickness).
const frame = plain([0.95, 0.95, 0.93]);
rect(0, -DOOR.halfWidth, [FRONT, 0], [BACK_ROOM.y0, DOOR.height], +1, frame);
rect(0, DOOR.halfWidth, [FRONT, 0], [BACK_ROOM.y0, DOOR.height], -1, frame);
rect(2, DOOR.height, [-DOOR.halfWidth, FRONT], [DOOR.halfWidth, BACK_ROOM.y0], -1, frame);
// Back room.
rect(0, -BACK_ROOM.x, [BACK_ROOM.y0, 0], [BACK_ROOM.y1, WALL_HEIGHT], +1, wall([0.9, 0.62, 0.6]));
rect(0, BACK_ROOM.x, [BACK_ROOM.y0, 0], [BACK_ROOM.y1, WALL_HEIGHT], -1, wall([0.9, 0.62, 0.6]));
rect(1, BACK_ROOM.y1, [-BACK_ROOM.x, 0], [BACK_ROOM.x, WALL_HEIGHT], -1, wall([0.96, 0.84, 0.5]));
box([-0.5, 5.6, 0], [0.5, 6.2, 0.9], checker([0.2, 0.3, 0.7], [0.9, 0.9, 0.95], 0.15)); // crate

// Furniture in the main room.
box([-1.6, 0.6, 0.72], [-0.6, 1.4, 0.76], wood); // table top
for (const [x, y] of [[-1.55, 0.65], [-0.7, 0.65], [-1.55, 1.3], [-0.7, 1.3]]) {
  box([x, y, 0], [x + 0.05, y + 0.05, 0.72], wood); // table legs
}
box([1.5, -0.8, 0], [2.2, -0.2, 1.8], checker([0.85, 0.35, 0.3], [0.95, 0.9, 0.85], 0.2)); // cabinet
box([0.6, 1.0, 0], [1.1, 1.5, 0.45], plain([0.35, 0.5, 0.42])); // stool
box([-0.15, -1.2, 0], [0.15, -0.9, 1.1], checker([0.2, 0.2, 0.2], [0.95, 0.85, 0.2], 0.1)); // post behind
// Posters, slightly in front of their walls.
rect(0, -2.49, [-0.6, 1.1], [0.4, 1.9], +1, checker([0.95, 0.95, 0.95], [0.15, 0.4, 0.8], 0.1));
rect(1, -1.99, [-1.2, 1.0], [0.2, 1.8], +1, checker([0.95, 0.95, 0.95], [0.75, 0.2, 0.5], 0.1));
rect(0, 2.49, [0.6, 0.9], [1.8, 1.7], -1, checker([0.95, 0.95, 0.95], [0.2, 0.6, 0.3], 0.1));

export const ROOM_RECTS = rects;

// Nearest surface hit by the ray from o along unit direction d, or null.
export function trace(o, d) {
  let best = Infinity;
  let hit = null;
  for (const r of rects) {
    const da = d[r.axis];
    if (da * r.normal[r.axis] >= 0) continue; // parallel, or seen from behind
    const t = (r.at - o[r.axis]) / da;
    if (t <= 1e-6 || t >= best) continue;
    const [a, b] = r.others;
    const pa = o[a] + t * d[a];
    if (pa < r.lo[0] || pa > r.hi[0]) continue;
    const pb = o[b] + t * d[b];
    if (pb < r.lo[1] || pb > r.hi[1]) continue;
    best = t;
    hit = r;
  }
  return hit && { t: best, rect: hit };
}

// Color of the surface seen along a ray, with simple lighting from a ceiling lamp.
function shade(o, d, hit) {
  const p = [o[0] + hit.t * d[0], o[1] + hit.t * d[1], o[2] + hit.t * d[2]];
  const n = hit.rect.normal;
  const base = hit.rect.pattern(p, n);
  const l = [LIGHT[0] - p[0], LIGHT[1] - p[1], LIGHT[2] - p[2]];
  const dist = Math.hypot(l[0], l[1], l[2]);
  const lambert = Math.max(0, (l[0] * n[0] + l[1] * n[1] + l[2] * n[2]) / dist);
  const light = 0.45 + 0.75 * lambert / (1 + 0.04 * dist * dist);
  return base.map((c) => Math.min(1, c * light));
}

// View direction of an equirectangular position (u, v in 0…1; u = 0.5 is FRONT, v = 0 is straight up).
export function directionAt(u, v) {
  const yaw = (u - 0.5) * 2 * Math.PI;
  const pitch = (0.5 - v) * Math.PI;
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c, Math.cos(yaw) * c, Math.sin(pitch)];
}

// Renders the room as seen from eye: an RGBA picture and the distance in meters along each
// pixel's ray. samples × samples rays per pixel smooth the picture's edges; depth uses the
// pixel's center ray only, so it stays exact.
export function renderRoom({ width = 2048, eye = EYE, samples = 2 } = {}) {
  const height = width / 2;
  const color = new Uint8ClampedArray(width * height * 4);
  const depth = new Float32Array(width * height);
  const sum = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const center = directionAt((x + 0.5) / width, (y + 0.5) / height);
      const hit = trace(eye, center);
      depth[i] = hit ? hit.t : 0;
      sum[0] = sum[1] = sum[2] = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const d = samples === 1 ? center : directionAt((x + (sx + 0.5) / samples) / width, (y + (sy + 0.5) / samples) / height);
          const h = samples === 1 ? hit : trace(eye, d);
          const c = h ? shade(eye, d, h) : [0, 0, 0];
          sum[0] += c[0];
          sum[1] += c[1];
          sum[2] += c[2];
        }
      }
      const k = 255 / (samples * samples);
      color[i * 4] = sum[0] * k;
      color[i * 4 + 1] = sum[1] * k;
      color[i * 4 + 2] = sum[2] * k;
      color[i * 4 + 3] = 255;
    }
  }
  return { width, height, color, depth };
}


function frac(v) {
  return v - Math.floor(v);
}
