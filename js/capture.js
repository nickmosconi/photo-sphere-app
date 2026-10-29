import { showVersion, VERSION } from "./version.js?v=0.3.1";
import * as db from "./db.js?v=0.3.1";
import { buildSessionZip } from "./export.js?v=0.3.1";
import { TARGETS } from "./targets.js?v=0.3.1";
import {
  angleBetween,
  axisAngle,
  cameraDirection,
  CircularMean,
  conjugate,
  directionFromYawPitch,
  fromDeviceOrientation,
  multiply,
  rotate,
  wrapDeg,
  yawPitchFromDirection,
} from "./quat.js?v=0.3.1";

showVersion();
db.requestPersistentStorage();

// Field of view across the long side of the frame for the iPhone main camera ("Back Camera"),
// as tuned in the Stitch Lab on the first real session.
const FOV_LONG_DEG = 68;
const CAPTURE_ANGLE_DEG = 3.5; // how close a dot must be to the ring's center
const STEADY_MS = 300; // how long the phone must be held still before a photo
const STEADY_DEG = 0.8; // how much movement still counts as "still"
const JPEG_QUALITY = 0.9;
const COMPASS_SAMPLES_NEEDED = 45; // ~0.75 s of compass readings to line up a resumed capture
const COMPASS_WAIT_MS = 4000; // give up on the compass after this and assume no shift

const $ = (id) => document.getElementById(id);
const video = $("camera");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");
const frameCanvas = document.createElement("canvas");

let stream = null;
let listening = false;
let wakeLock = null;

let session = null; // the capture being worked on (saved in IndexedDB)
let segment = null; // current stretch of capturing; a new one starts after every pause
let segmentStartMs = 0;
let done = new Map(); // targetId -> shot details (without the photo)
let capturing = false;
let busy = false;

let latest = null; // latest raw orientation reading
let q = null; // latest orientation as a quaternion
let camDir = null; // world direction the camera is looking
let compassMean = new CircularMean();

let nearest = null; // closest target that still needs a photo
let nearestAngle = Infinity;
let anchor = null; // { dir, t }: where the phone was when it last stopped moving
let ringSince = null;
let holdProgress = 0;

const view = { w: 0, h: 0, dpr: 1, f: 1 };

// ---------- Start screen ----------

$("new-button").addEventListener("click", () => beginCapture(null));
$("finished-back").addEventListener("click", showStartScreen);
$("finished-export").addEventListener("click", () => openExport(session.id));
$("cancel-button").addEventListener("click", cancelCapture);
$("undo-button").addEventListener("click", undoLastShot);
$("done-button").addEventListener("click", finishCapture);
$("export-close").addEventListener("click", closeExport);
$("share-button").addEventListener("click", shareExport);

showStartScreen();

async function showStartScreen(message = "") {
  showScreen("start");
  $("start-error").textContent = message;
  const list = $("session-list");
  list.replaceChildren();
  let sessions = [];
  try {
    sessions = await db.listSessions();
  } catch (err) {
    console.error(err);
    $("start-error").textContent = "Couldn't open saved captures on this device.";
  }
  if (sessions.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None yet.";
    list.append(li);
  }
  for (const s of sessions) list.append(sessionRow(s));
}

function sessionRow(s) {
  const li = document.createElement("li");
  const when = new Date(s.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const status = s.status === "complete" ? "finished" : "unfinished";
  li.innerHTML = `<div class="session-title"></div><div class="session-meta"></div><div class="session-actions"></div>`;
  li.querySelector(".session-title").textContent = when;
  li.querySelector(".session-meta").textContent = `${s.shotCount ?? 0} / ${TARGETS.length} photos · ${status}`;
  const actions = li.querySelector(".session-actions");
  if (s.status !== "complete") actions.append(button("Continue", () => beginCapture(s)));
  actions.append(button("Export", () => openExport(s.id)));
  actions.append(
    button("Delete", async () => {
      if (!confirm("Delete this capture and all its photos?")) return;
      await db.deleteSession(s.id);
      showStartScreen();
    }),
  );
  return li;
}

function button(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "small-button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function showScreen(name) {
  $("start-screen").hidden = name !== "start";
  $("finished-screen").hidden = name !== "finished";
  $("capture-ui").hidden = name !== "capture";
  overlay.hidden = name !== "capture";
}

// ---------- Starting, pausing and finishing ----------

async function beginCapture(existing) {
  $("start-error").textContent = "";
  setStartButtonsDisabled(true);
  try {
    if (!window.isSecureContext) throw new Error("NOT_SECURE");
    // iOS only shows the motion prompt when asked directly from a tap, so this must be the first await.
    await requestOrientationPermission();
    await startCamera();

    if (existing) {
      session = existing;
      done = new Map();
      for (const { blob, ...shot } of await db.getShots(session.id)) done.set(shot.targetId, shot);
    } else {
      session = newSession();
      done = new Map();
    }
    session.status = "capturing";

    const track = stream.getVideoTracks()[0];
    segment = {
      index: session.segments.length,
      startedAt: new Date().toISOString(),
      video: { width: video.videoWidth, height: video.videoHeight },
      cameraLabel: track.label,
      // The first segment defines the frame; later ones are lined up with it using the compass.
      yawShiftDeg: session.segments.length === 0 ? 0 : null,
      compassOffsetDeg: null,
      compassSamples: 0,
    };
    session.segments.push(segment);
    segmentStartMs = performance.now();
    compassMean = new CircularMean();
    anchor = null;
    ringSince = null;
    await saveSession();

    capturing = true;
    showScreen("capture");
    resizeOverlay();
    $("camera-info").textContent = `${video.videoWidth}×${video.videoHeight} · ${track.label}`;
    requestWakeLock();
  } catch (err) {
    console.error(err);
    stopCamera();
    $("start-error").textContent = explain(err);
  } finally {
    setStartButtonsDisabled(false);
  }
}

function newSession() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const focalPx = Math.max(vw, vh) / 2 / Math.tan((FOV_LONG_DEG * Math.PI) / 360);
  const fov = (px) => (2 * Math.atan(px / 2 / focalPx) * 180) / Math.PI;
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: null,
    status: "capturing",
    appVersion: VERSION,
    userAgent: navigator.userAgent,
    video: { width: vw, height: vh },
    cameraLabel: stream.getVideoTracks()[0].label,
    fovEstimate: {
      note: "Tuned in the Stitch Lab for the iPhone main camera",
      longSideDeg: FOV_LONG_DEG,
      widthDeg: fov(vw),
      heightDeg: fov(vh),
      focalPx,
    },
    yaw0Deg: null, // camera yaw when the capture started; targets are placed relative to it
    compassOffsetDeg: null, // average (camera yaw − compass heading) during segment 0
    targetCount: TARGETS.length,
    shotCount: 0,
    segments: [],
  };
}

function setStartButtonsDisabled(disabled) {
  document.querySelectorAll("#start-screen button").forEach((b) => (b.disabled = disabled));
}

async function saveSession() {
  if (segment && compassMean.count > 0) {
    segment.compassOffsetDeg = compassMean.mean();
    segment.compassSamples = compassMean.count;
    if (segment.index === 0) session.compassOffsetDeg = segment.compassOffsetDeg;
  }
  session.shotCount = done.size;
  session.updatedAt = new Date().toISOString();
  await db.putSession(session);
}

// Safari may reset the orientation zero and stop the camera in the background,
// so leaving the page pauses the capture; Continue starts a new segment.
async function pauseCapture(message) {
  if (!capturing) return;
  capturing = false;
  stopCamera();
  releaseWakeLock();
  await saveSession().catch(console.error);
  showStartScreen(message);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    pauseCapture("Paused. Tap Continue to pick up where you left off.");
  }
});

async function cancelCapture() {
  if (busy) return;
  if (!confirm("Delete this capture and all its photos?")) return;
  capturing = false;
  stopCamera();
  releaseWakeLock();
  await db.deleteSession(session.id);
  session = null;
  showStartScreen();
}

async function finishCapture() {
  if (busy) return;
  const missing = TARGETS.length - done.size;
  if (missing > 0 && !confirm(`${missing} ${missing === 1 ? "spot has" : "spots have"} no photo yet. Finish anyway?`)) {
    return;
  }
  capturing = false;
  session.status = "complete";
  await saveSession();
  stopCamera();
  releaseWakeLock();
  $("finished-summary").textContent = `${done.size} of ${TARGETS.length} photos saved on this phone.`;
  showScreen("finished");
}

async function undoLastShot() {
  if (busy || done.size === 0) return;
  const last = [...done.values()].reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
  busy = true;
  try {
    await db.deleteShot(last.id);
    done.delete(last.targetId);
    await saveSession();
  } finally {
    busy = false;
  }
}

// ---------- Sensors and camera ----------

async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent === "undefined") throw new Error("NO_ORIENTATION");
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    const result = await DeviceOrientationEvent.requestPermission();
    if (result !== "granted") throw new Error("MOTION_DENIED");
  }
  if (!listening) {
    window.addEventListener("deviceorientation", onOrientation);
    listening = true;
  }
}

async function startCamera() {
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("NO_CAMERA_API");
  const size = { width: { ideal: 4032 }, height: { ideal: 3024 } };
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, ...size },
  });
  // On iPhone Pros the default rear camera is a "Triple"/"Dual" camera that switches lenses
  // by itself, which would break stitching. Switch to the plain main lens if there is one.
  const main = await findMainBackCamera();
  if (main && main.deviceId !== stream.getVideoTracks()[0].getSettings().deviceId) {
    stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: { exact: main.deviceId }, ...size },
    });
  }
  stream.getVideoTracks()[0].addEventListener("ended", () =>
    pauseCapture("The camera stopped. Tap Continue to pick up where you left off."),
  );
  video.srcObject = stream;
  await video.play();
}

async function findMainBackCamera() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === "videoinput");
  return (
    cameras.find((d) => d.label === "Back Camera") ??
    cameras.find((d) => /back/i.test(d.label) && !/dual|triple|ultra|tele/i.test(d.label)) ??
    null
  );
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function onOrientation(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  latest = {
    alpha: e.alpha,
    beta: e.beta,
    gamma: e.gamma,
    heading: e.webkitCompassHeading ?? null,
    headingAccuracy: e.webkitCompassAccuracy ?? null,
  };
  q = fromDeviceOrientation(e.alpha, e.beta, e.gamma);
  camDir = cameraDirection(q);
  if (!capturing) return;
  if (session.yaw0Deg == null) session.yaw0Deg = yawPitchFromDirection(camDir).yaw;
  trackCompass();
  updateAim(performance.now());
}

// Keeps a running average of (camera yaw − compass heading). After a pause the orientation
// zero may have moved; comparing this average with segment 0's tells us by how much.
function trackCompass() {
  const { heading, headingAccuracy } = latest;
  if (heading == null || headingAccuracy == null || headingAccuracy < 0) return;
  const { yaw, pitch } = yawPitchFromDirection(camDir);
  if (Math.abs(pitch) > 60) return; // the compass is unreliable when pointing up or down
  compassMean.add(yaw - heading);
  if (segment.yawShiftDeg == null && compassMean.count >= COMPASS_SAMPLES_NEEDED) {
    segment.yawShiftDeg =
      session.compassOffsetDeg == null ? 0 : wrapDeg(compassMean.mean() - session.compassOffsetDeg);
  }
}

function targetsReady() {
  if (segment.yawShiftDeg == null && performance.now() - segmentStartMs > COMPASS_WAIT_MS) {
    segment.yawShiftDeg = 0;
    segment.note = "No compass reading; assumed no shift";
  }
  return session.yaw0Deg != null && segment.yawShiftDeg != null;
}

// Where a target is in the current orientation frame.
function targetDir(t) {
  return directionFromYawPitch(session.yaw0Deg + t.yaw + segment.yawShiftDeg, t.pitch);
}

function isPortrait() {
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  return angle === 0;
}

// Finds the nearest target still needing a photo and takes it once it's in the ring and steady.
function updateAim(now) {
  nearest = null;
  nearestAngle = Infinity;
  holdProgress = 0;
  if (busy || !targetsReady() || !isPortrait()) {
    ringSince = null;
    return;
  }
  for (const t of TARGETS) {
    if (done.has(t.id)) continue;
    const a = angleBetween(camDir, targetDir(t));
    if (a < nearestAngle) {
      nearestAngle = a;
      nearest = t;
    }
  }
  if (!anchor || angleBetween(camDir, anchor.dir) > STEADY_DEG) anchor = { dir: camDir, t: now };
  if (!nearest || nearestAngle > CAPTURE_ANGLE_DEG) {
    ringSince = null;
    return;
  }
  ringSince ??= now;
  const held = now - Math.max(anchor.t, ringSince);
  holdProgress = Math.min(1, held / STEADY_MS);
  if (held >= STEADY_MS) takePhoto(nearest);
}

async function takePhoto(target) {
  busy = true;
  holdProgress = 0;
  ringSince = null;
  const reading = { ...latest };
  const quaternion = q;
  try {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (frameCanvas.width !== vw || frameCanvas.height !== vh) {
      frameCanvas.width = vw;
      frameCanvas.height = vh;
    }
    frameCanvas.getContext("2d").drawImage(video, 0, 0, vw, vh);
    const timestamp = Date.now();
    flash();
    haptic();
    const blob = await new Promise((resolve, reject) =>
      frameCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG_FAILED"))), "image/jpeg", JPEG_QUALITY),
    );
    const shot = {
      sessionId: session.id,
      targetId: target.id,
      targetYawDeg: target.yaw,
      targetPitchDeg: target.pitch,
      segment: segment.index,
      quaternion,
      quaternionAligned: multiply(axisAngle([0, 0, 1], segment.yawShiftDeg), quaternion),
      ...reading,
      timestamp,
      screenAngle: screen.orientation?.angle ?? window.orientation ?? 0,
      width: vw,
      height: vh,
      blob,
    };
    shot.id = await db.addShot(shot);
    delete shot.blob;
    done.set(target.id, shot);
    await saveSession();
  } catch (err) {
    console.error(err);
    alert(`Couldn't save that photo: ${err.message}`);
  } finally {
    busy = false;
    anchor = null;
  }
}

function flash() {
  const el = $("flash");
  el.classList.remove("on");
  void el.offsetWidth; // restart the animation
  el.classList.add("on");
}

// iOS Safari has no navigator.vibrate, but toggling a "switch" checkbox gives a light haptic tap on iOS 18+.
function haptic() {
  if (navigator.vibrate) {
    navigator.vibrate(40);
    return;
  }
  const label = document.createElement("label");
  label.style.display = "none";
  label.innerHTML = '<input type="checkbox" switch>';
  document.body.append(label);
  label.click();
  label.remove();
}

// ---------- Drawing the dots ----------

window.addEventListener("resize", resizeOverlay);
requestAnimationFrame(render);

function resizeOverlay() {
  view.dpr = window.devicePixelRatio || 1;
  view.w = overlay.clientWidth;
  view.h = overlay.clientHeight;
  overlay.width = Math.round(view.w * view.dpr);
  overlay.height = Math.round(view.h * view.dpr);
  // The video fills the screen like CSS object-fit: cover, so work out its on-screen focal length.
  const vw = video.videoWidth || 3;
  const vh = video.videoHeight || 4;
  const scale = Math.max(view.w / vw, view.h / vh);
  const focalPx = Math.max(vw, vh) / 2 / Math.tan((FOV_LONG_DEG * Math.PI) / 360);
  view.f = focalPx * scale;
}

// Screen position of a world direction, or { behind: true } if it's behind the camera.
function project(dir) {
  const v = rotate(conjugate(q), dir);
  if (v[2] >= -1e-6) return { behind: true, v };
  const k = view.f / -v[2];
  return { x: view.w / 2 + v[0] * k, y: view.h / 2 - v[1] * k, v };
}

function onScreen(p, margin = 0) {
  return !p.behind && p.x >= -margin && p.x <= view.w + margin && p.y >= -margin && p.y <= view.h + margin;
}

function render() {
  requestAnimationFrame(render);
  if (!capturing) return;
  if (overlay.width !== Math.round(overlay.clientWidth * view.dpr)) resizeOverlay();

  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);

  const ready = q && targetsReady();
  if (ready) {
    for (const t of TARGETS) {
      const p = project(targetDir(t));
      if (!onScreen(p, 20)) continue;
      if (done.has(t.id)) drawDot(p, 7, "#4cd964");
      else if (t !== nearest) drawDot(p, 11, "rgba(77, 163, 255, 0.95)");
    }
    if (nearest) {
      const p = project(targetDir(nearest));
      if (onScreen(p)) drawDot(p, 15, "#ffd84d");
      else drawArrow(p.v);
    }
  }

  // Center ring, with a progress arc while holding still.
  const r = Math.max(26, view.f * Math.tan((CAPTURE_ANGLE_DEG * Math.PI) / 180));
  const cx = view.w / 2;
  const cy = view.h / 2;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  if (holdProgress > 0) {
    ctx.lineWidth = 6;
    ctx.strokeStyle = "#ffd84d";
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + holdProgress * Math.PI * 2);
    ctx.stroke();
  }

  $("progress").textContent = `${done.size} / ${TARGETS.length}`;
  $("undo-button").disabled = done.size === 0;
  setText($("hint"), hintText(ready));
}

function drawDot(p, radius, color) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
  ctx.stroke();
}

// Arrow near the screen edge pointing toward an off-screen target (v is in device coordinates).
function drawArrow(v) {
  let dx = v[0];
  let dy = -v[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    dx = 0;
    dy = 1;
  } else {
    dx /= len;
    dy /= len;
  }
  const dist = Math.min(view.w, view.h) / 2 - 48;
  const x = view.w / 2 + dx * dist;
  const y = view.h / 2 + dy * dist;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(dy, dx));
  ctx.beginPath();
  ctx.moveTo(22, 0);
  ctx.lineTo(-12, -16);
  ctx.lineTo(-12, 16);
  ctx.closePath();
  ctx.fillStyle = "#ffd84d";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
  ctx.stroke();
  ctx.restore();
}

function hintText(ready) {
  if (!latest) return performance.now() - segmentStartMs > 2000 ? "No motion data. Capturing needs a phone." : "";
  if (!isPortrait()) return "Hold the phone upright (portrait).";
  if (!ready) return "Hold the phone upright for a moment…";
  if (done.size === TARGETS.length) return "All photos taken. Tap Done.";
  if (busy) return "Saving…";
  if (holdProgress > 0) return "Hold still…";
  return "Move the ring onto the yellow dot.";
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// ---------- Export ----------

let exportFile = null;
let exportUrl = null;

async function openExport(sessionId) {
  $("export-panel").hidden = false;
  $("share-button").hidden = true;
  $("download-link").hidden = true;
  const status = $("export-status");
  status.textContent = "Getting photos…";
  try {
    const s = await db.getSession(sessionId);
    const shots = await db.getShots(sessionId);
    if (shots.length === 0) {
      status.textContent = "This capture has no photos yet.";
      return;
    }
    exportFile = await buildSessionZip(s, shots, (pct) => {
      status.textContent = `Packing ${shots.length} photos… ${Math.round(pct)}%`;
    });
    status.textContent = `${exportFile.name} (${(exportFile.size / 1e6).toFixed(1)} MB) is ready.`;
    if (navigator.canShare?.({ files: [exportFile] })) $("share-button").hidden = false;
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(exportFile);
    const link = $("download-link");
    link.href = exportUrl;
    link.download = exportFile.name;
    link.hidden = false;
  } catch (err) {
    console.error(err);
    status.textContent = `Couldn't make the zip: ${err.message}`;
  }
}

async function shareExport() {
  try {
    await navigator.share({ files: [exportFile], title: exportFile.name });
  } catch (err) {
    if (err.name !== "AbortError") $("export-status").textContent = `Sharing failed: ${err.message}`;
  }
}

function closeExport() {
  $("export-panel").hidden = true;
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = null;
  exportFile = null;
}

// ---------- Messages ----------

function explain(err) {
  switch (err?.message) {
    case "NOT_SECURE":
      return "This page must be opened with an https:// link.";
    case "NO_ORIENTATION":
      return "This browser doesn't provide motion data.";
    case "MOTION_DENIED":
      return "Motion access was not allowed. Fully close Safari (swipe it away), open this page again, tap the button and choose Allow.";
    case "NO_CAMERA_API":
      return "This browser can't use the camera.";
  }
  switch (err?.name) {
    case "NotAllowedError":
      return 'Camera access was blocked. In Safari, tap the "aA" button in the address bar → Website Settings → Camera → Allow, then try again.';
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found.";
    case "NotReadableError":
      return "The camera is busy in another app. Close that app and try again.";
  }
  return `Something went wrong: ${err?.message || err}`;
}
