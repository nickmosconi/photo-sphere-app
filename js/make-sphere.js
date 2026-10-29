import { ALIGN_SIZE, grayCopy, refineOrientations } from "./align.js?v=0.6.0";
import * as db from "./db.js?v=0.6.0";
import { computeGains, SMALL_SIZE, smallCopy } from "./exposure.js?v=0.6.0";
import { canvasToJpeg, decodeImage, freeImage } from "./images.js?v=0.6.0";
import { MAX_PHOTO_SIZE, photoOrientation, SPHERE_WIDTHS, STITCH_DEFAULTS } from "./stitch-settings.js?v=0.6.0";
import { Stitcher } from "./stitcher.js?v=0.6.0";
import { addGPanoXmp } from "./xmp.js?v=0.6.0";

const JPEG_QUALITY = 0.92;
const THUMB_WIDTH = 640;

// Stitches a saved capture session into a 360° JPEG and saves it as a sphere.
// onProgress(fraction, message) reports how far along it is. widths: sizes to try, largest first.
export async function makeSphere(sessionId, onProgress, widths = SPHERE_WIDTHS) {
  const started = performance.now();
  const session = await db.getSession(sessionId);
  const shots = await db.getShots(sessionId);
  if (shots.length === 0) throw new Error("This capture has no photos.");
  const n = shots.length;
  const settings = { ...STITCH_DEFAULTS, yaw0Deg: session.yaw0Deg ?? 0 };

  // First pass: smaller copies of every photo, for lining them up and matching brightness.
  for (const [i, shot] of shots.entries()) {
    onProgress?.((0.4 * i) / n, `Reading photo ${i + 1} of ${n}…`);
    const image = await decodeImage(shot.blob, settings.refine ? ALIGN_SIZE : SMALL_SIZE);
    if (settings.refine) shot.gray = grayCopy(image);
    shot.small = smallCopy(image);
    freeImage(image);
  }
  if (settings.refine) {
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

  // Second pass: stitch the full photos, one at a time, at the largest size the phone manages.
  let result = null;
  for (const [k, outputWidth] of widths.entries()) {
    try {
      result = await stitchAndEncode(shots, { ...settings, outputWidth }, (i) =>
        onProgress?.(0.5 + (0.5 * i) / n, k === 0 ? `Adding photo ${i + 1} of ${n}…` : `Trying a smaller size… ${i + 1} of ${n}`),
      );
      break;
    } catch (err) {
      console.error(`Stitching at ${outputWidth} wide failed`, err);
      if (k === widths.length - 1) throw err;
    }
  }
  const { width, height, jpeg, thumb } = result;
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
    thumb,
  };
  await db.putSphere(sphere);
  return sphere;
}

// Stitches the photos at settings.outputWidth and encodes the JPEG and a thumbnail.
// Throws if the phone can't manage that size, so a smaller one can be tried.
async function stitchAndEncode(shots, settings, onPhoto) {
  const canvas = document.createElement("canvas");
  const stitcher = new Stitcher();
  try {
    await stitcher.stitchOneByOne(
      settings,
      canvas,
      shots.length,
      async (i) => {
        onPhoto(i);
        const shot = shots[i];
        return {
          image: await decodeImage(shot.blob, MAX_PHOTO_SIZE),
          quaternion: shot.quaternion,
          quaternionAligned: shot.quaternionAligned,
          quaternionRefined: shot.quaternionRefined,
          gain: shot.gain,
        };
      },
      freeImage,
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
