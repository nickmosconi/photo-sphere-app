import { showVersion, VERSION } from "./version.js?v=0.4.0";
import * as db from "./db.js?v=0.4.0";
import { PanoViewer } from "./viewer.js?v=0.4.0";

showVersion();

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get("id");
const viewer = new PanoViewer($("viewer"));
const info = $("view-info");
const homeUrl = `./?v=${VERSION.slice(1)}`;

let file = null; // the sphere as a JPEG file, ready to share

$("gyro-button").addEventListener("click", toggleGyro);
$("share-button").addEventListener("click", share);
$("delete-button").addEventListener("click", remove);

load();

async function load() {
  const sphere = id ? await db.getSphere(id).catch(() => null) : null;
  if (!sphere) {
    info.textContent = "This sphere isn't on this device.";
    document.querySelectorAll(".bottom-bar button").forEach((b) => (b.disabled = true));
    return;
  }
  const img = new Image();
  img.src = URL.createObjectURL(sphere.image);
  await img.decode();
  viewer.setSource(img);

  const when = new Date(sphere.capturedAt ?? sphere.createdAt);
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}`;
  file = new File([sphere.image], `sphere-${stamp}.jpg`, { type: "image/jpeg" });
  info.textContent = when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

async function toggleGyro() {
  const button = $("gyro-button");
  const on = !viewer.gyro;
  try {
    await viewer.setGyro(on);
    button.classList.toggle("primary", on);
    button.textContent = on ? "Drag" : "Move phone";
  } catch (err) {
    info.textContent = err.message;
  }
}

async function share() {
  if (!file) return;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err.name !== "AbortError") info.textContent = `Sharing failed: ${err.message}`;
    }
    return;
  }
  // No share sheet (e.g. on a PC): download the file instead.
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function remove() {
  if (!confirm("Delete this sphere from this phone? The photos of the capture are kept.")) return;
  await db.deleteSphere(id);
  location.href = homeUrl;
}
