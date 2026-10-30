import { grayCopy, refineOrientations } from "./align.js?v=0.8.0";
import * as db from "./db.js?v=0.8.0";
import { computeGains, smallCopy } from "./exposure.js?v=0.8.0";
import { canvasToJpeg, decodeImage, freeImage, imageToJpeg } from "./images.js?v=0.8.0";
import { JpegEncoder } from "./jpeg-encoder.js?v=0.8.0";
import { MAX_PHOTO_SIZE, photoOrientation, SPHERE_SIZES, STITCH_DEFAULTS } from "./stitch-settings.js?v=0.8.0";
import { Stitcher } from "./stitcher.js?v=0.8.0";
import { addGPanoXmp } from "./xmp.js?v=0.8.0";

const JPEG_QUALITY = 0.92;
const THUMB_WIDTH = 640;

// If Safari runs out of memory it kills the page without warning, so nothing here can catch it.
// Instead, what's being done is written down as it goes; if the page reloads with that note still
// there, the last attempt crashed, and from then on this phone uses the next smaller size.
const PROGRESS_KEY = "sphere-cam-making";
const MAX_WIDTH_KEY = "sphere-cam-max-width";

// Call when the page loads. Returns { stage, width } if the last sphere attempt crashed, else null.
export function checkForCrash() {
  const note = readStorage(PROGRESS_KEY);
  if (!note) return null;
  writeStorage(PROGRESS_KEY, null);
  if (note.width) {
    const smaller = SPHERE_SIZES.find((s) => s.width < note.width);
    if (smaller) writeStorage(MAX_WIDTH_KEY, smaller.width);
  }
  return note;
}

// Stitches a saved capture session into a 360° JPEG and saves it as a sphere.
// onProgress(fraction, message) reports how far along it is.
// sizes: [{ width, strips }] to try, largest first (normally SPHERE_SIZES, minus any that crashed).
export async function makeSphere(sessionId, onProgress, sizes = sizesForThisPhone()) {
  const started = performance.now();
  const session = await db.getSession(sessionId);
  const shots = await db.getShots(sessionId);
  if (shots.length === 0) throw new Error("This capture has no photos.");
  const n = shots.length;
  const settings = { ...STITCH_DEFAULTS, yaw0Deg: session.yaw0Deg ?? 0 };
  const note = (stage, width = null) => writeStorage(PROGRESS_KEY, { stage, width, sessionId });

  try {
    // First pass: smaller copies of every photo, for lining them up and matching brightness, plus
    // a stitching-size JPEG, so the stitch (which may read a photo once per strip) decodes small
    // 2048-pixel files instead of the 12-megapixel originals.
    for (const [i, shot] of shots.entries()) {
      onProgress?.((0.4 * i) / n, `Reading photo ${i + 1} of ${n}…`);
      note(`reading photo ${i + 1} of ${n}`);
      const image = await decodeImage(shot.blob, MAX_PHOTO_SIZE, shot);
      if (settings.refine) shot.gray = grayCopy(image);
      shot.small = smallCopy(image);
      shot.stitchBlob = await imageToJpeg(image, 0.95);
      freeImage(image);
    }
    if (settings.refine) {
      note("lining up photos");
      const start = shots.map((shot) => ({ gray: shot.gray, quaternion: photoOrientation(shot, { ...settings, refine: false }) }));
      const aligned = await refineOrientations(start, settings, (round, rounds) =>
        onProgress?.(0.4 + (0.1 * round) / rounds, "Lining up photos…"),
      );
      shots.forEach((shot, i) => {
        shot.quaternionRefined = aligned.quaternions[i];
        shot.gray = null;
      });
      settings.alignment = { matches: aligned.matches, beforeDeg: aligned.beforeDeg, afterDeg: aligned.afterDeg };
    }
    if (settings.matchExposure) {
      const { gains, vignette } = computeGains(shots, settings);
      shots.forEach((shot, i) => (shot.gain = gains[i]));
      settings.vignette = vignette;
    }
    shots.forEach((shot) => (shot.small = null));

    // Second pass: stitch the full photos, one at a time, at the largest size the phone manages.
    let result = null;
    for (const [k, size] of sizes.entries()) {
      try {
        result = await stitchAndEncode(shots, { ...settings, outputWidth: size.width }, size, (i, strip) => {
          const part = size.strips > 1 ? ` (part ${strip + 1} of ${size.strips})` : "";
          onProgress?.(0.5 + (0.5 * (strip + i / n)) / size.strips, `${k === 0 ? "Adding" : "Trying a smaller size: adding"} photo ${i + 1} of ${n}${part}…`);
          note(`stitching at ${size.width} wide${part}, photo ${i + 1} of ${n}`, size.width);
        });
        break;
      } catch (err) {
        console.error(`Stitching at ${size.width} wide failed`, err);
        if (k === sizes.length - 1) throw err;
      }
    }
    note("saving");
    const { width, height, jpeg, thumb, tiles } = result;
    settings.outputWidth = width;
    const headingDeg = poseHeading(session, shots);
    const image = await addGPanoXmp(jpeg, { width, height, headingDeg });

    const sphere = {
      id: crypto.randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      capturedAt: session.createdAt,
      width,
      height,
      headingDeg,
      stitchSeconds: (performance.now() - started) / 1000,
      settings,
      image,
      tiles, // for spheres too big to show in one piece: left and right halves for the viewer
      thumb,
    };
    await db.putSphere(sphere);
    return sphere;
  } finally {
    writeStorage(PROGRESS_KEY, null); // finished or failed normally: not a crash
  }
}

// Sphere sizes to try on this phone: all of them, unless a bigger one crashed before.
function sizesForThisPhone() {
  const maxWidth = readStorage(MAX_WIDTH_KEY);
  const sizes = SPHERE_SIZES.filter((s) => !maxWidth || s.width <= maxWidth);
  return sizes.length ? sizes : SPHERE_SIZES.slice(-1);
}

// Stitches the photos at settings.outputWidth and encodes the JPEG and a thumbnail.
// Throws if the phone can't manage that size, so a smaller one can be tried.
async function stitchAndEncode(shots, settings, size, onPhoto) {
  if (size.streamed) return stitchStreamed(shots, settings, size.strips, onPhoto);
  const strips = size.strips;
  const canvas = document.createElement("canvas");
  const stitcher = new Stitcher();
  try {
    await stitcher.stitchOneByOne(
      settings,
      canvas,
      shots,
      async (i, strip) => {
        onPhoto(i, strip);
        return decodeImage(shots[i].stitchBlob, MAX_PHOTO_SIZE);
      },
      freeImage,
      strips,
    );
  } catch (err) {
    canvas.width = canvas.height = 0;
    throw err;
  } finally {
    stitcher.dispose();
  }
  try {
    const { width, height } = canvas;
    const jpeg = await canvasToJpeg(canvas, JPEG_QUALITY);
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = THUMB_WIDTH;
    thumbCanvas.height = THUMB_WIDTH / 2;
    const g = thumbCanvas.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumb = await canvasToJpeg(thumbCanvas, 0.8);
    return { width, height, jpeg, thumb };
  } finally {
    canvas.width = canvas.height = 0; // free the big canvas now
  }
}

// For spheres bigger than Safari's canvas limit: each finished strip is passed straight to JPEG
// encoders (the full sphere for sharing, plus left and right halves the viewer can load one at a
// time) and into the thumbnail, so the whole image never exists in memory at once.
async function stitchStreamed(shots, settings, strips, onPhoto) {
  const width = settings.outputWidth;
  const height = width / 2;
  const full = new JpegEncoder(width, height, Math.round(JPEG_QUALITY * 100));
  const halves = [0, 1].map(() => new JpegEncoder(width / 2, height, Math.round(JPEG_QUALITY * 100)));
  const thumbW = THUMB_WIDTH;
  const thumbH = THUMB_WIDTH / 2;
  const sums = new Float32Array(thumbW * thumbH * 4); // r, g, b, count
  const stitcher = new Stitcher();
  try {
    await stitcher.stitchOneByOne(
      settings,
      (rgba, w, rows, y) => {
        full.addRows(rgba, w * 4, 0, rows);
        halves[0].addRows(rgba, w * 4, 0, rows);
        halves[1].addRows(rgba, w * 4, w / 2, rows);
        // Thumbnail: average every 4th pixel into its thumbnail cell.
        for (let r = 0; r < rows; r += 4) {
          const ty = Math.floor(((y + r) * thumbH) / height);
          for (let x = 0; x < w; x += 4) {
            const t = (ty * thumbW + Math.floor((x * thumbW) / width)) * 4;
            const i = (r * w + x) * 4;
            sums[t] += rgba[i];
            sums[t + 1] += rgba[i + 1];
            sums[t + 2] += rgba[i + 2];
            sums[t + 3]++;
          }
        }
      },
      shots,
      async (i, strip) => {
        onPhoto(i, strip);
        return decodeImage(shots[i].stitchBlob, MAX_PHOTO_SIZE);
      },
      freeImage,
      strips,
    );
  } finally {
    stitcher.dispose();
  }
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = thumbW;
  thumbCanvas.height = thumbH;
  const pixels = new ImageData(thumbW, thumbH);
  for (let t = 0; t < sums.length; t += 4) {
    const n = sums[t + 3] || 1;
    pixels.data[t] = sums[t] / n;
    pixels.data[t + 1] = sums[t + 1] / n;
    pixels.data[t + 2] = sums[t + 2] / n;
    pixels.data[t + 3] = 255;
  }
  thumbCanvas.getContext("2d").putImageData(pixels, 0, 0);
  const thumb = await canvasToJpeg(thumbCanvas, 0.8);
  return { width, height, jpeg: full.finish(), tiles: halves.map((h) => h.finish()), thumb };
}

// Compass heading of the panorama's center (the direction of the first horizon dot), or null.
// The session tracks the average (camera yaw − compass heading), so heading = yaw − that.
function poseHeading(session, shots) {
  let heading = null;
  if (session.compassOffsetDeg != null && session.yaw0Deg != null) {
    heading = session.yaw0Deg - session.compassOffsetDeg;
  } else {
    heading = shots.find((s) => s.targetId === "h00")?.heading ?? null;
  }
  return heading == null ? null : ((heading % 360) + 360) % 360;
}

function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (e.g. private browsing): crash detection just won't work.
  }
}
