import { TARGETS } from "./targets.js?v=0.5.1";
import { axisAngle, fromDeviceOrientation, multiply, toMatrix3 } from "./quat.js?v=0.5.1";

// A fake capture session made from a computer-drawn test sphere, with exactly known
// orientations and field of view. If this stitches cleanly but a real session doesn't,
// the problem is in the phone's data, not the stitcher.

const PHOTO_WIDTH = 600; // portrait 3:4, like the iPhone frames (scaled down)
const PHOTO_HEIGHT = 800;
const TRUE_FOV_LONG_DEG = 68; // same as the iPhone main camera, so the default settings fit

// noiseDeg: typical size of a random orientation error added to each photo's recorded quaternion.
export async function makeSyntheticSession({ noiseDeg = 0, onProgress } = {}) {
  const pano = makeTestPanorama(4096);
  const panoData = pano.getContext("2d").getImageData(0, 0, pano.width, pano.height);
  const focal = PHOTO_HEIGHT / 2 / Math.tan((TRUE_FOV_LONG_DEG * Math.PI) / 360);

  const shots = [];
  for (const [i, t] of TARGETS.entries()) {
    onProgress?.(i, TARGETS.length);
    await new Promise((r) => setTimeout(r)); // let the page update between photos
    // An upright phone with no tilt to the side: beta = 90° + pitch, alpha = −yaw.
    const trueQ = fromDeviceOrientation(-t.yaw, 90 + t.pitch, 0);
    const recordedQ = noiseDeg > 0 ? multiply(trueQ, randomRotation(noiseDeg)) : trueQ;
    shots.push({
      targetId: t.id,
      targetYawDeg: t.yaw,
      targetPitchDeg: t.pitch,
      segment: 0,
      quaternion: recordedQ,
      quaternionAligned: recordedQ,
      image: renderPhoto(panoData, trueQ, focal),
    });
  }

  return {
    name: noiseDeg > 0 ? `Synthetic test (±${noiseDeg}° sensor error)` : "Synthetic test (perfect sensors)",
    session: {
      id: "synthetic",
      createdAt: new Date().toISOString(),
      cameraLabel: "Synthetic",
      video: { width: PHOTO_WIDTH, height: PHOTO_HEIGHT },
      yaw0Deg: 0,
      fovEstimate: { longSideDeg: TRUE_FOV_LONG_DEG },
      segments: [{ index: 0, yawShiftDeg: 0 }],
      synthetic: { noiseDeg, trueFovLongDeg: TRUE_FOV_LONG_DEG },
    },
    shots,
    truth: pano,
  };
}

// Equirectangular test pattern: colored 15° cells, grid lines, and labeled directions.
// The center of the image is "FRONT" (yaw 0); right of center is turning right.
export function makeTestPanorama(width) {
  const height = width / 2;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  const x = (lon) => ((((lon / 360 + 0.5) % 1) + 1) % 1) * width;
  const y = (lat) => (0.5 - lat / 180) * height;
  const cell = width / 24;

  for (let lon = 0; lon < 360; lon += 15) {
    for (let lat = -90; lat < 90; lat += 15) {
      const checker = (((lon + lat) / 15) % 2 + 2) % 2 === 0;
      g.fillStyle = `hsl(${lon}, ${checker ? 75 : 50}%, ${25 + ((lat + 90) / 180) * 45}%)`;
      g.fillRect(x(lon), y(lat + 15), cell + 1, height / 12 + 1);
    }
  }

  const line = (x1, y1, x2, y2, w, color) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  };
  for (let lon = 0; lon < 360; lon += 15) {
    line(x(lon), 0, x(lon), height, lon % 45 === 0 ? 4 : 1.5, "rgba(255,255,255,0.8)");
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    line(0, y(lat), width, y(lat), lat % 45 === 0 ? 4 : 1.5, "rgba(255,255,255,0.8)");
  }
  line(0, y(0), width, y(0), 6, "#ffe14d");

  g.fillStyle = "#fff";
  g.strokeStyle = "rgba(0,0,0,0.7)";
  g.textAlign = "center";
  g.textBaseline = "middle";
  const label = (text, lon, lat, size) => {
    g.font = `bold ${size}px sans-serif`;
    g.lineWidth = size / 8;
    for (const dx of [0, width, -width]) {
      g.strokeText(text, x(lon) + dx, y(lat));
      g.fillText(text, x(lon) + dx, y(lat));
    }
  };
  for (const [lon, name] of [[0, "FRONT"], [90, "RIGHT"], [180, "BACK"], [270, "LEFT"]]) {
    label(name, lon, 7, width / 40);
  }
  for (let lon = 0; lon < 360; lon += 30) {
    label(`${lon}°`, lon + 7.5, -7, width / 110);
    label(`${lon}° up`, lon + 7.5, 52, width / 110);
    label(`${lon}° down`, lon + 7.5, -38, width / 110);
  }
  for (let lon = 0; lon < 360; lon += 90) {
    label("UP", lon + 45, 80, width / 70);
    label("DOWN", lon + 45, -80, width / 70);
  }
  return canvas;
}

// Renders what a camera with orientation q would see of the panorama.
function renderPhoto(panoData, q, focal) {
  const { width: pw, height: ph, data: src } = panoData;
  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_WIDTH;
  canvas.height = PHOTO_HEIGHT;
  const g = canvas.getContext("2d");
  const out = g.createImageData(PHOTO_WIDTH, PHOTO_HEIGHT);
  const m = toMatrix3(q);
  let o = 0;
  for (let py = 0; py < PHOTO_HEIGHT; py++) {
    const dy = -(py + 0.5 - PHOTO_HEIGHT / 2) / focal;
    for (let px = 0; px < PHOTO_WIDTH; px++) {
      const dx = (px + 0.5 - PHOTO_WIDTH / 2) / focal;
      // Camera looks along device −Z.
      const wx = m[0] * dx + m[1] * dy - m[2];
      const wy = m[3] * dx + m[4] * dy - m[5];
      const wz = m[6] * dx + m[7] * dy - m[8];
      const yaw = Math.atan2(wx, wy);
      const pitch = Math.asin(wz / Math.hypot(wx, wy, wz));
      const sx = Math.min(pw - 1, Math.floor((yaw / (2 * Math.PI) + 0.5) * pw));
      const sy = Math.min(ph - 1, Math.floor((0.5 - pitch / Math.PI) * ph));
      const s = (sy * pw + sx) * 4;
      out.data[o++] = src[s];
      out.data[o++] = src[s + 1];
      out.data[o++] = src[s + 2];
      out.data[o++] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return canvas;
}

// A random small rotation, roughly normally distributed in size.
function randomRotation(sizeDeg) {
  const u = Math.random() * 2 - 1;
  const phi = Math.random() * 2 * Math.PI;
  const r = Math.sqrt(1 - u * u);
  const gaussian = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  return axisAngle([r * Math.cos(phi), r * Math.sin(phi), u], gaussian * sizeDeg);
}
