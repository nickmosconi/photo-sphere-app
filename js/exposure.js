import { axisAngle, multiply, toMatrix3 } from "./quat.js?v=0.6.1";
import { photoOrientation } from "./stitch-settings.js?v=0.6.1";

// Brightness matching. The iPhone adjusts exposure and white balance for every photo, and
// each photo is darker toward its edges (lens vignetting), so neighboring photos differ in
// brightness, which shows as patches once seams are sharp. Using small copies of the photos,
// this finds one gain per color channel per photo, plus one vignetting strength shared by all
// photos, so that overlapping areas match. Model for a pixel at distance r from the photo
// center (r² = 1 in the corners): true color ≈ gain × pixel × exp(vignette × r²).

export const SMALL_SIZE = 160; // long side of the copies used for matching

const GRID_W = 360; // sample the sphere every 1°
const GRID_H = 180;
const EDGE_MARGIN = 0.03; // ignore the very edge of each photo
const PRIOR = 2; // how strongly gains are pulled toward 1

// Makes the small copy of a photo used for matching: { data, width, height }.
export function smallCopy(image) {
  const scale = SMALL_SIZE / Math.max(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(image, 0, 0, canvas.width, canvas.height);
  const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height };
}

// photos: [{ small, quaternion, quaternionAligned?, quaternionRefined? }]; settings: the stitch settings.
// Returns { gains: one [r, g, b] per photo, vignette: [r, g, b] }.
export function computeGains(photos, settings) {
  const n = photos.length;
  const offset = multiply(
    multiply(axisAngle([0, 1, 0], settings.yawOffsetDeg), axisAngle([1, 0, 0], settings.pitchOffsetDeg)),
    axisAngle([0, 0, 1], settings.rollOffsetDeg),
  );
  const tanHalf = Math.tan((settings.fovLongDeg * Math.PI) / 360);
  const cams = photos.map((p) => ({
    m: toMatrix3(multiply(photoOrientation(p, settings), offset)),
    f: Math.max(p.small.width, p.small.height) / 2 / tanHalf,
    ...p.small,
  }));

  // Least squares in log space, one system per color channel. Unknowns: log gain of each
  // photo, then the vignetting strength. Every point seen by photos i and j gives
  //   (logGain_i − logGain_j) + vignette × (r²_i − r²_j) = log pixel_j − log pixel_i.
  const size = n + 1;
  const normal = [0, 1, 2].map(() => Array.from({ length: size }, () => new Float64Array(size)));
  const rhs = [0, 1, 2].map(() => new Float64Array(size));
  const seen = new Float64Array(n);
  const hits = [];
  for (let y = 0; y < GRID_H; y++) {
    const pitch = (0.5 - (y + 0.5) / GRID_H) * Math.PI;
    const step = Math.max(1, Math.round(1 / Math.max(Math.cos(pitch), 0.05))); // fewer samples near the poles
    for (let x = 0; x < GRID_W; x += step) {
      const yaw = ((x + 0.5) / GRID_W) * 2 * Math.PI;
      const d = [Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
      hits.length = 0;
      for (let i = 0; i < n; i++) {
        const hit = sample(cams[i], d);
        if (hit) hits.push([i, ...hit]);
      }
      for (let a = 0; a < hits.length; a++) {
        for (let b = a + 1; b < hits.length; b++) {
          const [i, ri, ...ci] = hits[a];
          const [j, rj, ...cj] = hits[b];
          const dr = ri - rj;
          seen[i]++;
          seen[j]++;
          for (let c = 0; c < 3; c++) {
            // Skip nearly black or blown-out pixels, where the log is unreliable.
            if (ci[c] < 12 || cj[c] < 12 || ci[c] > 250 || cj[c] > 250) continue;
            const y = Math.log(cj[c]) - Math.log(ci[c]);
            const N = normal[c];
            const R = rhs[c];
            // Row of the system: +1 at i, −1 at j, dr at the vignette column.
            N[i][i] += 1; N[j][j] += 1; N[i][j] -= 1; N[j][i] -= 1;
            N[i][n] += dr; N[n][i] += dr; N[j][n] -= dr; N[n][j] -= dr;
            N[n][n] += dr * dr;
            R[i] += y; R[j] -= y; R[n] += dr * y;
          }
        }
      }
    }
  }

  const gains = photos.map(() => [1, 1, 1]);
  const vignette = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const N = normal[c];
    // Pull each log gain toward 0 (gain 1); this also fixes the overall brightness level.
    for (let i = 0; i < n; i++) N[i][i] += PRIOR + (seen[i] === 0 ? 1 : 0);
    N[n][n] += PRIOR;
    const x = solve(N, rhs[c]);
    for (let i = 0; i < n; i++) gains[i][c] = Math.exp(x[i]);
    vignette[c] = x[n];
  }
  return { gains, vignette };
}

// [r², red, green, blue] of the photo in direction d, or null if d isn't inside it.
// r² is the squared distance from the photo center, 1 in the corners.
function sample(cam, d) {
  const { m, f, width, height, data } = cam;
  // m is camera→world (row-major), so its transpose takes world → camera.
  const vz = m[2] * d[0] + m[5] * d[1] + m[8] * d[2];
  if (vz > -1e-3) return null;
  const vx = m[0] * d[0] + m[3] * d[1] + m[6] * d[2];
  const vy = m[1] * d[0] + m[4] * d[1] + m[7] * d[2];
  const u = (vx / -vz) * f / width + 0.5;
  const v = 0.5 - ((vy / -vz) * f) / height;
  if (u < EDGE_MARGIN || u > 1 - EDGE_MARGIN || v < EDGE_MARGIN || v > 1 - EDGE_MARGIN) return null;
  const i = (Math.floor(v * height) * width + Math.floor(u * width)) * 4;
  const r2 = ((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2;
  return [r2, data[i], data[i + 1], data[i + 2]];
}

// Solves A·x = b (small, symmetric positive definite) by Gaussian elimination.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= factor * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
