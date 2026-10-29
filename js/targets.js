// The spots to photograph. Yaw is relative to the direction the phone pointed when the capture started.
export const TARGETS = [
  ...ring("h", 0, 12), // horizon, every 30°
  ...ring("u", 45, 8), // upper ring
  ...ring("d", -45, 8), // lower ring
  { id: "up", yaw: 0, pitch: 90 },
  { id: "down", yaw: 0, pitch: -90 },
];

function ring(prefix, pitch, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${String(i).padStart(2, "0")}`,
    yaw: (i * 360) / count,
    pitch,
  }));
}
