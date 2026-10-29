import { showVersion, VERSION } from "./version.js?v=0.5.1";
import * as db from "./db.js?v=0.5.1";

showVersion();
showSpheres();

// Lists the spheres saved on this device, newest first.
async function showSpheres() {
  let spheres = [];
  try {
    spheres = await db.listSpheres();
  } catch (err) {
    console.error(err);
  }
  if (spheres.length === 0) return;
  const grid = document.getElementById("sphere-grid");
  for (const s of spheres) {
    const a = document.createElement("a");
    a.className = "sphere-card";
    a.href = `view.html?id=${s.id}&v=${VERSION.slice(1)}`;
    const img = document.createElement("img");
    img.alt = "";
    img.src = URL.createObjectURL(s.thumb);
    const label = document.createElement("span");
    label.textContent = new Date(s.capturedAt ?? s.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    a.append(img, label);
    grid.append(a);
  }
  document.getElementById("spheres").hidden = false;
}
