import * as db from "./db.js?v=0.4.0";
import { canvasToJpeg, decodeImage, freeImage } from "./images.js?v=0.4.0";
import { MAX_PHOTO_SIZE, STITCH_DEFAULTS } from "./stitch-settings.js?v=0.4.0";
import { Stitcher } from "./stitcher.js?v=0.4.0";
import { addGPanoXmp } from "./xmp.js?v=0.4.0";

const JPEG_QUALITY = 0.92;
const THUMB_WIDTH = 640;

// Stitches a saved capture session into a 360° JPEG and saves it as a sphere.
// onProgress(done, total) is called as photos are added.
export async function makeSphere(sessionId, onProgress) {
  const started = performance.now();
  const session = await db.getSession(sessionId);
  const shots = await db.getShots(sessionId);
  if (shots.length === 0) throw new Error("This capture has no photos.");

  const settings = { ...STITCH_DEFAULTS, yaw0Deg: session.yaw0Deg ?? 0 };
  const canvas = document.createElement("canvas");
  const stitcher = new Stitcher();
  try {
    await stitcher.stitchOneByOne(
      settings,
      canvas,
      shots.length,
      async (i) => {
        onProgress?.(i, shots.length);
        const shot = shots[i];
        return { image: await decodeImage(shot.blob, MAX_PHOTO_SIZE), quaternion: shot.quaternion, quaternionAligned: shot.quaternionAligned };
      },
      freeImage,
    );
  } finally {
    stitcher.dispose();
  }
  onProgress?.(shots.length, shots.length);

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
