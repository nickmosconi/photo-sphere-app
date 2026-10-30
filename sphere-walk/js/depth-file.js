// Depth maps are saved as ordinary PNG pictures so they can be opened anywhere and survive
// Google Drive, email and the like. Each pixel holds a distance in millimeters along that
// pixel's view ray: red × 256 + green (so up to 65.5 m). 0 means "unknown" (for example sky).
// The Python depth tool (sphere-walk/tools/) writes the same format.

export const MAX_DEPTH_M = 65.535;

export async function depthToPng(depth, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  const img = g.createImageData(width, height);
  for (let i = 0; i < depth.length; i++) {
    const mm = Math.max(0, Math.min(65535, Math.round(depth[i] * 1000)));
    img.data[i * 4] = mm >> 8;
    img.data[i * 4 + 1] = mm & 255;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  try {
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the depth PNG."))), "image/png"),
    );
  } finally {
    canvas.width = canvas.height = 0;
  }
}

export async function depthFromPng(blob) {
  // No color correction: the numbers in the pixels must come back exactly as saved.
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const { width, height } = bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = g.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 0;
  const depth = new Float32Array(width * height);
  for (let i = 0; i < depth.length; i++) depth[i] = (data[i * 4] * 256 + data[i * 4 + 1]) / 1000;
  return { width, height, depth };
}

// How well an estimated depth map matches the true one (both in meters, same size).
// Median relative error, and the share of pixels within 10% and 25% of the truth.
export function compareDepth(estimate, truth) {
  const errors = [];
  for (let i = 0; i < truth.length; i++) {
    if (truth[i] > 0 && estimate[i] > 0) errors.push(Math.abs(estimate[i] - truth[i]) / truth[i]);
  }
  if (!errors.length) return null;
  errors.sort((a, b) => a - b);
  const within = (limit) => errors.filter((e) => e <= limit).length / errors.length;
  return { medianError: errors[errors.length >> 1], within10: within(0.1), within25: within(0.25) };
}

// Finds how far below the camera the floor is, from the depth straight down (more than 50° below
// the horizon, where a normal room shows only floor). Multiply depth by
// (phone height / this) to put it in real meters.
export function floorDistance(depth, width, height) {
  const heights = [];
  const firstRow = Math.floor(height * (0.5 + 50 / 180)); // 50° below the horizon
  for (let y = firstRow; y < height; y++) {
    const pitch = (0.5 - (y + 0.5) / height) * Math.PI;
    const down = Math.sin(-pitch);
    for (let x = 0; x < width; x += 2) {
      const d = depth[y * width + x];
      if (d > 0) heights.push(d * down);
    }
  }
  if (!heights.length) return null;
  heights.sort((a, b) => a - b);
  return heights[heights.length >> 1];
}
