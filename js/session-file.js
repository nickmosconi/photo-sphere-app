import { loadJSZip } from "./jszip.js?v=0.3.1";

// Opens a session .zip exported by the capture page. Photos larger than maxSize on their
// long side are scaled down, which is plenty for the panorama and saves memory.
export async function loadSessionZip(file, maxSize, onProgress) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const jsonEntry = zip.file("session.json");
  if (!jsonEntry) throw new Error("There's no session.json inside. Is this a Sphere Cam export?");
  const json = JSON.parse(await jsonEntry.async("string"));

  const shots = [];
  for (const [i, shot] of json.shots.entries()) {
    onProgress?.(i, json.shots.length);
    const entry = zip.file(shot.file);
    if (!entry) throw new Error(`${shot.file} is missing from the zip.`);
    const blob = new Blob([await entry.async("arraybuffer")], { type: "image/jpeg" });
    shots.push({ ...shot, image: await decodeImage(blob, maxSize) });
  }
  return { name: file.name, session: json.session, shots };
}

async function decodeImage(blob, maxSize) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}
