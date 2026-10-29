import { ALIGN_SIZE, grayCopy, refineOrientations } from "./align.js?v=0.5.1";
import * as db from "./db.js?v=0.5.1";
import { computeGains, SMALL_SIZE, smallCopy } from "./exposure.js?v=0.5.1";
import { canvasToJpeg, decodeImage, freeImage } from "./images.js?v=0.5.1";
import { MAX_PHOTO_SIZE, photoOrientation, STITCH_DEFAULTS } from "./stitch-settings.js?v=0.5.1";
import { Stitcher } from "./stitcher.js?v=0.5.1";
import { addGPanoXmp } from "./xmp.js?v=0.5.1";

const JPEG_QUALITY = 0.92;
const THUMB_WIDTH = 640;

// Stitches a saved capture session into a 360° JPEG and saves it as a sphere.
// onProgress(fraction, message) reports how far along it is.
export async function makeSphere(sessionId, onProgress) {
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

  // Second pass: stitch the full photos, one at a time.
  const canvas = document.createElement("canvas");
  const stitcher = new Stitcher();
  try {
    await stitcher.stitchOneByOne(
      settings,
      canvas,
      n,
      async (i) => {
        onProgress?.(0.5 + (0.5 * i) / n, `Adding photo ${i + 1} of ${n}…`);
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
  } finally {
    stitcher.dispose();
  }
  onProgress?.(1, "Saving…");

  const { width, height } = canvas;
  const headingDeg = poseHeading(session, shots);
  const image = await addGPanoXmp(await canvasToJpeg(canvas, JPEG_QUALITY), { width, height, headingDeg });
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = THUMB_WIDTH;
  thumbCanvas.height = THUMB_WIDTH / 2;
  const g = thumbCanvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumb = await canvasToJpeg(thumbCanvas, 0.8);
  canvas.width = canvas.height = 0; // free the big canvas now

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
