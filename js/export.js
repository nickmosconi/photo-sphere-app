import { loadJSZip } from "./jszip.js?v=0.3.0";
import { VERSION } from "./version.js?v=0.3.0";

// Describes the numbers in session.json, for the Stitch Lab and for anyone reading the file.
const CONVENTIONS = {
  quaternion: "[x, y, z, w]; rotates device-frame vectors into the world frame",
  worldFrame:
    "Z straight up, X/Y horizontal. Yaw is clockwise from +Y seen from above. iOS alpha has an arbitrary zero, so yaw is relative, not true north.",
  deviceFrame: "Portrait: X right of the screen, Y toward the top of the phone, Z out of the screen toward the user",
  camera: "Rear camera looks along device -Z; image right = device +X, image up = device +Y",
  eulerOrder: "W3C DeviceOrientation: alpha about Z, then beta about the new X, then gamma about the new Y",
  segments:
    "alpha's zero can change when Safari reloads or goes to the background, so each restart starts a new segment. quaternionAligned is the quaternion turned about the vertical by the segment's yawShiftDeg (estimated from the compass) into segment 0's frame.",
};

// Packs a session's photos and a session.json into a .zip File.
export async function buildSessionZip(session, shots, onProgress) {
  const JSZip = await loadJSZip();
  const zip = new JSZip();

  const entries = shots.map((shot, i) => ({
    file: `photos/${String(i + 1).padStart(2, "0")}-${shot.targetId}.jpg`,
    shot,
  }));

  const json = {
    format: "sphere-cam-session",
    formatVersion: 1,
    appVersion: VERSION,
    exportedAt: new Date().toISOString(),
    conventions: CONVENTIONS,
    session,
    shots: entries.map(({ file, shot }) => {
      const { blob, sessionId, ...meta } = shot;
      return { file, ...meta };
    }),
  };

  zip.file("session.json", JSON.stringify(json, null, 2));
  for (const { file, shot } of entries) zip.file(file, shot.blob);

  // JPEGs are already compressed, so just store them.
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (meta) =>
    onProgress?.(meta.percent),
  );
  return new File([blob], `sphere-session-${fileStamp(session.createdAt)}.zip`, {
    type: "application/zip",
  });
}

function fileStamp(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
