import { showVersion } from "./version.js?v=0.3.1";
import { Stitcher } from "./stitcher.js?v=0.3.1";
import { PanoViewer } from "./viewer.js?v=0.3.1";
import { loadSessionZip } from "./session-file.js?v=0.3.1";
import { makeSyntheticSession } from "./synthetic.js?v=0.3.1";

showVersion();

// Starting values. When good values are found, paste the "Copy settings" output here.
// 68° fits the first real iPhone session best (overlap agreement was lowest at 67–68°);
// the offsets showed no clear preference, so they stay at 0.
const DEFAULTS = {
  fovLongDeg: 68,
  yawOffsetDeg: 0,
  pitchOffsetDeg: 0,
  rollOffsetDeg: 0,
  feather: 0.5,
  outputWidth: 4096,
  useAligned: true,
  tint: false,
};

const SLIDERS = [
  { key: "fovLongDeg", label: "Field of view (long side)", min: 40, max: 100, step: 0.1, unit: "°" },
  { key: "yawOffsetDeg", label: "Yaw offset", min: -10, max: 10, step: 0.05, unit: "°" },
  { key: "pitchOffsetDeg", label: "Pitch offset", min: -10, max: 10, step: 0.05, unit: "°" },
  { key: "rollOffsetDeg", label: "Roll offset", min: -10, max: 10, step: 0.05, unit: "°" },
  { key: "feather", label: "Feather width", min: 0.02, max: 1, step: 0.01, unit: "" },
];

const SETTINGS_KEY = "sphere-cam-lab-settings";
const MAX_PHOTO_SIZE = 2048;

const $ = (id) => document.getElementById(id);
const flatCanvas = $("flat-canvas"); // the stitcher draws here; the 360° view reads from it too
const viewer = new PanoViewer($("viewer"));

let settings = loadSettings();
let current = null; // the loaded session
let stitcher = null;
let viewerWidth = 0; // output width the viewer's texture was made for
let stitchQueued = false;

try {
  stitcher = new Stitcher();
} catch (err) {
  $("stitch-info").textContent = err.message;
}

// ---------- Controls ----------

const sliderControls = {};
for (const s of SLIDERS) {
  const label = document.createElement("label");
  label.className = "slider";
  label.innerHTML = `<span class="slider-head"><span></span><output></output></span><input type="range">`;
  label.querySelector(".slider-head span").textContent = s.label;
  const input = label.querySelector("input");
  Object.assign(input, { min: s.min, max: s.max, step: s.step });
  input.addEventListener("input", () => {
    settings[s.key] = Number(input.value);
    changed();
  });
  sliderControls[s.key] = { input, output: label.querySelector("output"), s };
  $("sliders").append(label);
}

$("use-aligned").addEventListener("change", (e) => {
  settings.useAligned = e.target.checked;
  changed();
});
$("tint").addEventListener("change", (e) => {
  settings.tint = e.target.checked;
  changed();
});
$("output-width").addEventListener("change", (e) => {
  settings.outputWidth = Number(e.target.value);
  changed();
});
$("reset-button").addEventListener("click", () => {
  settings = { ...DEFAULTS };
  changed();
});
$("copy-button").addEventListener("click", copySettings);
$("download-button").addEventListener("click", downloadJpeg);

const noise = $("noise");
noise.addEventListener("input", () => ($("noise-out").textContent = `±${noise.value}°`));
$("noise-out").textContent = `±${noise.value}°`;
$("synthetic-button").addEventListener("click", loadSynthetic);

showSettings();

function changed() {
  showSettings();
  saveSettings();
  requestStitch();
}

function showSettings() {
  for (const { input, output, s } of Object.values(sliderControls)) {
    input.value = settings[s.key];
    output.textContent = `${Number(settings[s.key]).toFixed(s.step < 0.1 ? 2 : 1)}${s.unit}`;
  }
  $("use-aligned").checked = settings.useAligned;
  $("tint").checked = settings.tint;
  $("output-width").value = String(settings.outputWidth);
}

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not important: settings just won't be remembered.
  }
}

async function copySettings() {
  const text = JSON.stringify(settings, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $("stitch-info").textContent = "Settings copied.";
  } catch {
    prompt("Copy these settings:", text);
  }
}

function downloadJpeg() {
  if (!current) return;
  flatCanvas.toBlob(
    (blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${current.name.replace(/\.zip$/i, "").replace(/[^\w.-]+/g, "-")}-${settings.outputWidth}.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },
    "image/jpeg",
    0.92,
  );
}

// ---------- Loading sessions ----------

const dropZone = $("drop-zone");
$("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) openZip(file);
});
// Accept a drop anywhere on the page, so a missed drop doesn't make the browser open the file.
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("over");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) dropZone.classList.remove("over");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("over");
  const file = e.dataTransfer.files[0];
  if (file) openZip(file);
});

async function openZip(file) {
  setInfo(`Opening ${file.name}…`);
  try {
    const data = await loadSessionZip(file, MAX_PHOTO_SIZE, (i, n) => setInfo(`Loading photos… ${i + 1} / ${n}`));
    useSession(data);
  } catch (err) {
    console.error(err);
    setInfo(`Couldn't open that file: ${err.message}`);
  }
}

async function loadSynthetic() {
  setInfo("Making test photos…");
  const data = await makeSyntheticSession({
    noiseDeg: Number(noise.value),
    onProgress: (i, n) => setInfo(`Making test photos… ${i + 1} / ${n}`),
  });
  useSession(data);
}

function useSession(data) {
  if (!stitcher) return;
  stitcher.setPhotos(data.shots);
  // The photos are on the GPU now, so free the decoded copies.
  data.shots.forEach((s) => s.image.close?.());
  current = data;
  const s = data.session;
  const when = new Date(s.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const segments = s.segments?.length ?? 1;
  setInfo(
    `${data.name}\n${data.shots.length} photos · ${s.video.width}×${s.video.height} · ${s.cameraLabel}\n` +
      `${when}${segments > 1 ? ` · ${segments} segments (paused ${segments - 1}×)` : ""}`,
  );
  requestStitch();
}

function setInfo(text) {
  $("session-info").textContent = text;
}

// ---------- Stitching ----------

function requestStitch() {
  if (stitchQueued || !current || !stitcher) return;
  stitchQueued = true;
  requestAnimationFrame(() => {
    stitchQueued = false;
    stitch();
  });
}

function stitch() {
  const t0 = performance.now();
  try {
    stitcher.stitch({ ...settings, yaw0Deg: current.session.yaw0Deg ?? 0 }, flatCanvas);
  } catch (err) {
    console.error(err);
    $("stitch-info").textContent = err.message;
    return;
  }
  const ms = performance.now() - t0;
  if (viewerWidth !== settings.outputWidth) {
    viewer.setSource(flatCanvas);
    viewerWidth = settings.outputWidth;
  } else {
    viewer.refresh();
  }
  $("stitch-info").textContent = `${flatCanvas.width} × ${flatCanvas.height} stitched in ${Math.round(ms)} ms`;
}
