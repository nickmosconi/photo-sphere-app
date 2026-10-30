import { showVersion } from "./version.js?v=0.3.0";
import { decodeImage, imageToJpeg } from "../../js/images.js?v=0.8.0";
import { EYE, EYE_HEIGHT } from "./room.js?v=0.3.0";
import { compareDepth, depthFromPng, depthToPng, floorDistance } from "./depth-file.js?v=0.3.0";
import { buildDepthMesh, depthColors, WalkViewer } from "./walk-viewer.js?v=0.3.0";

showVersion();

const $ = (id) => document.getElementById(id);
const viewer = new WalkViewer($("viewer"));
const status = $("status");
const SPLAT_FILE = /\.(ply|spz|splat|ksplat|sog)$/i;

// What's being shown: a color picture (canvas) and its depth in meters, plus the true depth
// when it is known (the test room).
let source = null;
let loading = 0; // counts loads, so a slow one (the test room) can't replace a newer one
let colorTexture = null;
let depthTexture = null;

$("panel-button").addEventListener("click", () => ($("panel").hidden = !$("panel").hidden));
if (window.innerWidth < 700) $("panel").hidden = true;
$("room-button").addEventListener("click", loadRoom);
$("file-input").addEventListener("change", (e) => loadFiles([...e.target.files]));
$("eye-height").addEventListener("change", rebuild);
$("cut-edges").addEventListener("change", rebuild);
$("show-depth").addEventListener("change", rebuild);
$("show-truth").addEventListener("change", updateTruth);
$("flip-splat").addEventListener("change", () => viewer.setSplatFlipped($("flip-splat").checked));
$("reset-button").addEventListener("click", () => viewer.resetPosition());
$("save-room-button").addEventListener("click", saveRoom);
bindStick();

let truthTimer = 0;
viewer.onMove = (p) => {
  const moved = Math.hypot(p.x, p.y, p.z);
  const start = viewer.splat ? "At the start of the splat" : "At the spot where the sphere was taken";
  status.textContent = moved < 0.005 ? start : `${viewer.splat ? "Walked" : "Stepped"} ${moved.toFixed(2)} m away`;
  // The true view is drawn for one spot; redraw it once you stop moving.
  if ($("show-truth").checked) {
    clearTimeout(truthTimer);
    truthTimer = setTimeout(updateTruth, 200);
  }
};

loadRoom();

// Draws the test room in the background (a few seconds on a phone), so the page stays responsive.
function renderRoomInWorker(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./room-worker.js?v=0.3.0", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      worker.terminate();
      resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "The test room couldn't be drawn."));
    };
    worker.postMessage(options);
  });
}

async function loadRoom() {
  const load = ++loading;
  status.textContent = "Drawing the test room…";
  const room = await renderRoomInWorker({ width: 2048, samples: 2 }).catch((err) => {
    status.textContent = err.message;
    return null;
  });
  if (!room || load !== loading) return;
  const canvas = toCanvas(room.color, room.width, room.height);
  setSource({
    name: "Test room",
    isRoom: true,
    color: canvas,
    depth: room.depth,
    width: room.width,
    height: room.height,
    truth: room.depth,
  });
  $("eye-height").value = EYE_HEIGHT;
  rebuild();
}

// Loads a sphere and its depth map picked together, for example sphere.jpg + sphere.depth.png.
// A matching *.true-depth.png (from "Download test room") adds an accuracy check.
// A splat file (from a walking video, e.g. Scaniverse's PLY export) opens on its own.
async function loadFiles(files) {
  ++loading;
  $("file-input").value = "";
  const splatFile = files.find((f) => SPLAT_FILE.test(f.name));
  if (splatFile) return loadSplat(splatFile);
  const truthFile = files.find((f) => /\.true-depth\.png$/i.test(f.name));
  const depthFile = files.find((f) => f !== truthFile && /depth\.png$/i.test(f.name));
  const colorFile = files.find((f) => f !== truthFile && f !== depthFile);
  if (!colorFile || !depthFile) {
    status.textContent = "Pick the sphere picture and its depth file (name.depth.png) together.";
    return;
  }
  status.textContent = "Loading…";
  try {
    const { width, height, depth } = await depthFromPng(depthFile);
    const truth = truthFile ? await depthFromPng(truthFile) : null;
    const image = await decodeImage(colorFile, Math.min(4096, viewer.maxTextureSize));
    setSource({
      name: colorFile.name,
      isRoom: false,
      color: toCanvas(image),
      depth,
      width,
      height,
      truth: truth && resample(truth, width, height),
    });
    rebuild();
  } catch (err) {
    status.textContent = `Couldn't open those files: ${err.message}`;
  }
}

async function loadSplat(file) {
  status.textContent = `Opening ${file.name}…`;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    colorTexture?.dispose();
    depthTexture?.dispose();
    source = colorTexture = depthTexture = null;
    const splat = await viewer.setSplat(bytes, file.name);
    viewer.setSplatFlipped($("flip-splat").checked);
    setSplatControls(true);
    $("source-info").textContent = `${file.name}: ${splat.numSplats.toLocaleString()} splats. Walk anywhere; no step limit.`;
    $("scale-info").textContent = $("accuracy").textContent = "";
    status.textContent = "At the start of the splat";
  } catch (err) {
    console.error(err);
    status.textContent = `Couldn't open that splat: ${err.message}`;
  }
}

// Depth settings only apply to spheres; the flip only to splats.
function setSplatControls(splat) {
  $("flip-splat").disabled = !splat;
  for (const id of ["eye-height", "cut-edges", "show-depth"]) $(id).disabled = splat;
}

function setSource(next) {
  if (viewer.splat) viewer.setSplat(null);
  setSplatControls(false);
  colorTexture?.dispose();
  depthTexture?.dispose();
  source = next;
  colorTexture = viewer.makeTexture(next.color);
  depthTexture = null;
  $("show-truth").checked = false;
  $("show-truth").disabled = !next.isRoom;
  $("save-room-button").disabled = !next.isRoom;
  viewer.setAlternate(null);
  viewer.resetPosition();
  $("source-info").textContent = `${next.name}: picture ${next.color.width} × ${next.color.height}, depth ${next.width} × ${next.height}`;
}

// Real-world scale: depth estimates only know relative distances, so stretch them until the floor
// is as far below the camera as the phone was held above it.
function depthScale() {
  const found = floorDistance(source.depth, source.width, source.height);
  const height = Number($("eye-height").value) || EYE_HEIGHT;
  if (!found) {
    $("scale-info").textContent = "No floor found straight down; depth used as is.";
    return 1;
  }
  const scale = height / found;
  $("scale-info").textContent = `Floor found ${found.toFixed(2)} m below the camera → depth × ${scale.toFixed(2)}`;
  return scale;
}

function rebuild() {
  if (!source) return;
  const scale = depthScale();
  let texture = colorTexture;
  if ($("show-depth").checked) {
    depthTexture ??= viewer.makeTexture(depthColors(source.depth, source.width, source.height));
    texture = depthTexture;
  }
  viewer.setMesh(
    buildDepthMesh({
      texture,
      depth: source.depth,
      width: source.width,
      height: source.height,
      scale,
      cutEdges: $("cut-edges").checked,
    }),
  );
  showAccuracy(scale);
  if (!status.textContent || status.textContent.endsWith("…")) status.textContent = "At the spot where the sphere was taken";
}

function showAccuracy(scale) {
  const out = $("accuracy");
  if (!source.truth || source.truth === source.depth) {
    out.textContent = source.isRoom ? "Test room depth is exact." : "";
    return;
  }
  const scaled = source.depth.map((d) => d * scale);
  const result = compareDepth(scaled, source.truth);
  out.textContent = result
    ? `Compared with the true depth: typical error ${(result.medianError * 100).toFixed(1)}%, ` +
      `${Math.round(result.within10 * 100)}% of pixels within 10%, ${Math.round(result.within25 * 100)}% within 25%.`
    : "";
}

// Test room only: draws exactly what you would see from where you're standing now, so the
// 3D surface can be compared with the truth (toggle the box while looking at an edge).
let truthRequest = 0;
async function updateTruth() {
  const request = ++truthRequest;
  if (!$("show-truth").checked || !source?.isRoom) {
    viewer.setAlternate(null);
    return;
  }
  const p = viewer.position.clone();
  // three.js frame (Y up, −Z ahead) back to the room's (Z up, Y ahead).
  const eye = [EYE[0] + p.x, EYE[1] - p.z, EYE[2] + p.y];
  const room = await renderRoomInWorker({ width: 2048, eye, samples: 1 });
  if (request !== truthRequest || !$("show-truth").checked) return; // moved again meanwhile
  const mesh = buildDepthMesh({
    texture: viewer.makeTexture(toCanvas(room.color, room.width, room.height)),
    depth: room.depth,
    width: room.width,
    height: room.height,
  });
  mesh.position.copy(p);
  viewer.setAlternate(mesh);
}

async function saveRoom() {
  if (!source?.isRoom) return;
  download(await imageToJpeg(source.color, 0.95), "test-room.jpg");
  download(await depthToPng(source.truth, source.width, source.height), "test-room.true-depth.png");
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// On-screen stick: drag the knob; how far it is pushed sets the walking speed.
function bindStick() {
  const stick = $("stick");
  const knob = stick.querySelector(".knob");
  const RADIUS = 45;
  let id = null;
  const move = (e) => {
    const r = stick.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) {
      dx *= RADIUS / len;
      dy *= RADIUS / len;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    viewer.setStick(dx / RADIUS, -dy / RADIUS);
  };
  stick.addEventListener("pointerdown", (e) => {
    id = e.pointerId;
    stick.setPointerCapture(id);
    move(e);
  });
  stick.addEventListener("pointermove", (e) => e.pointerId === id && move(e));
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    knob.style.transform = "";
    viewer.setStick(0, 0);
  };
  stick.addEventListener("pointerup", end);
  stick.addEventListener("pointercancel", end);
}

function toCanvas(pixelsOrImage, width, height) {
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d");
  if (pixelsOrImage instanceof Uint8ClampedArray) {
    canvas.width = width;
    canvas.height = height;
    g.putImageData(new ImageData(pixelsOrImage, width, height), 0, 0);
  } else {
    if (pixelsOrImage instanceof HTMLCanvasElement) return pixelsOrImage;
    canvas.width = pixelsOrImage.width;
    canvas.height = pixelsOrImage.height;
    g.drawImage(pixelsOrImage, 0, 0);
    pixelsOrImage.close?.();
  }
  return canvas;
}

// Nearest-pixel copy of a depth map at another size.
function resample({ width, height, depth }, w, h) {
  if (width === w && height === h) return depth;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / h));
    for (let x = 0; x < w; x++) out[y * w + x] = depth[sy * width + Math.min(width - 1, Math.floor(((x + 0.5) * width) / w))];
  }
  return out;
}
