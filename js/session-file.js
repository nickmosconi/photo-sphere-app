import { decodeImage } from "./images.js?v=0.4.0";
import { loadJSZip } from "./jszip.js?v=0.4.0";

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
