import { showVersion, VERSION } from "./version.js?v=0.9.0";
import * as db from "./db.js?v=0.9.0";
import { buildSessionZip } from "./export.js?v=0.9.0";
import { checkForCrash, makeSphere } from "./make-sphere.js?v=0.9.0";
import { STITCH_DEFAULTS } from "./stitch-settings.js?v=0.9.0";
import { TARGETS } from "./targets.js?v=0.9.0";
import {
  angleBetween,
  axisAngle,
  cameraDirection,
  CircularMean,
  compassPoint,
  conjugate,
  directionFromYawPitch,
  fromDeviceOrientation,
  multiply,
  rotate,
  wrapDeg,
  yawPitchFromDirection,
} from "./quat.js?v=0.9.0";

showVersion();
db.requestPersistentStorage();

// Field of view across the long side of the frame for the iPhone main camera ("Back Camera"),
// as tuned in the Stitch Lab.
const FOV_LONG_DEG = STITCH_DEFAULTS.fovLongDeg;
const CAPTURE_ANGLE_DEG = 3.5; // how close a dot must be to the ring's center
const STEADY_MS = 300; // how long the phone must be held still before a photo
const STEADY_DEG = 0.8; // how much movement still counts as "still"
const JPEG_QUALITY = 0.9;
const BURST_FRAMES = 4; // frames compared for each photo; the sharpest is kept
const SHARPNESS_PATCH = 384; // size of the middle patch used to judge sharpness
const COMPASS_SAMPLES_NEEDED = 45; // ~0.75 s of compass readings to line up a resumed capture
const COMPASS_WAIT_MS = 4000; // give up on the compass after this and assume no shift

// Path mode (Sphere Walk, opened as capture.html?path=<id>): spheres are captured a few steps
// apart, and the walk to each one (steps and compass direction) is saved with it.
const PATH_ID = new URLSearchParams(location.search).get("path");
const HEADING_WINDOW_MS = 1000; // compass readings averaged when the walk is recorded

const $ = (id) => document.getElementById(id);
const video = $("camera");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");
const frameCanvas = document.createElement("canvas");
const patchCanvas = document.createElement("canvas");
patchCanvas.width = patchCanvas.height = SHARPNESS_PATCH;
const patchCtx = patchCanvas.getContext("2d", { willReadFrequently: true });

let stream = null;
let listening = false;
let wakeLock = null;

let session = null; // the capture being worked on (saved in IndexedDB)
let segment = null; // current stretch of capturing; a new one starts after every pause
let segmentStartMs = 0;
let done = new Map(); // targetId -> shot details (without the photo)
let capturing = false;
let busy = false;
let stopping = false; // Done or Cancel was tapped: take no new photos
let finishedSessionId = null; // session shown on the finished screen

let latest = null; // latest raw orientation reading
let q = null; // latest orientation as a quaternion
let camDir = null; // world direction the camera is looking
let compassMean = new CircularMean();

let nearest = null; // closest target that still needs a photo
let nearestAngle = Infinity;
let anchor = null; // { dir, t }: where the phone was when it last stopped moving
let ringSince = null;
let holdProgress = 0;

let pathCount = 0; // path mode: index the next sphere gets
let pendingWalk = null; // path mode: the walk recorded for the sphere about to be captured
let walkSteps = 3;
let walkHeadings = []; // recent compass readings on the walk screen

const view = { w: 0, h: 0, dpr: 1, f: 1 };

// ---------- Start screen ----------

$("new-button").addEventListener("click", () => (PATH_ID && pathCount > 0 ? openWalkScreen() : beginCapture(null)));
$("finished-back").addEventListener("click", () => showStartScreen());
$("finished-export").addEventListener("click", () => openExport(finishedSessionId));
$("finished-retry").addEventListener("click", () => buildSphere(finishedSessionId));
$("cancel-button").addEventListener("click", cancelCapture);
$("undo-button").addEventListener("click", undoLastShot);
$("done-button").addEventListener("click", finishCapture);
$("export-close").addEventListener("click", closeExport);
$("share-button").addEventListener("click", shareExport);
$("walk-fewer").addEventListener("click", () => setWalkSteps(walkSteps - 1));
$("walk-more").addEventListener("click", () => setWalkSteps(walkSteps + 1));
$("walk-next").addEventListener("click", captureNextOnPath);
if (PATH_ID) {
  document.querySelector("#start-screen h1").textContent = "Capture a path";
  document.querySelector("#start-screen .tip").textContent =
    "Capture a sphere at each spot along your path, a few steps apart. Between spheres you'll walk, and the app records how far and which way.";
  $("start-back").href = "sphere-walk/paths.html?v=0.3.0";
  $("start-back").textContent = "← Paths";
}

const crash = checkForCrash();
showStartScreen(
  crash
    ? `Safari ran out of memory while making your last sphere (${crash.stage}). ` +
        (crash.width ? "This phone will use a smaller sphere size from now on. " : "") +
        "Your photos are safe: tap Make sphere to try again."
    : "",
);

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
  if (PATH_ID) {
    sessions = sessions.filter((s) => s.path?.id === PATH_ID);
    pathCount = Math.max(-1, ...sessions.map((s) => s.path.index)) + 1;
    $("new-button").textContent = `Capture sphere ${pathCount + 1}`;
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
  li.querySelector(".session-title").textContent = s.path ? `Path sphere ${s.path.index + 1} · ${when}` : when;
  li.querySelector(".session-meta").textContent = `${s.shotCount ?? 0} / ${TARGETS.length} photos · ${status}`;
  const actions = li.querySelector(".session-actions");
  if (s.status !== "complete") actions.append(button("Continue", () => beginCapture(s)));
  if (s.shotCount > 0) actions.append(button("Make sphere", () => buildSphere(s.id)));
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
  $("walk-screen").hidden = name !== "walk";
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
    // Path mode: which sphere of the path this is, and the walk from the previous one
    // (steps, and the compass direction the camera faced while walking; null for the first).
    ...(PATH_ID && {
      path: { id: PATH_ID, index: pathCount, steps: null, headingDeg: null, ...pendingWalk },
    }),
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

// A photo may be saving when Done or Cancel is tapped. Pause taking new ones and wait for it,
// rather than ignoring the tap.
async function stopTakingPhotos() {
  stopping = true;
  while (busy) await new Promise((resolve) => setTimeout(resolve, 50));
}

async function cancelCapture() {
  if (stopping) return;
  await stopTakingPhotos();
  stopping = false;
  if (!confirm("Delete this capture and all its photos?")) return;
  capturing = false;
  stopCamera();
  releaseWakeLock();
  await db.deleteSession(session.id);
  session = null;
  showStartScreen();
}

async function finishCapture() {
  if (stopping) return;
  await stopTakingPhotos();
  stopping = false;
  const missing = TARGETS.length - done.size;
  if (missing > 0 && !confirm(`${missing} ${missing === 1 ? "spot has" : "spots have"} no photo yet. Finish anyway?`)) {
    return;
  }
  capturing = false;
  session.status = "complete";
  await saveSession();
  stopCamera();
  releaseWakeLock();
  frameCanvas.width = frameCanvas.height = 0; // free the 12-megapixel photo buffer before stitching
  if (PATH_ID && session.path) {
    // Path mode: walk on to the next spot; spheres are made later from the list.
    pathCount = Math.max(pathCount, session.path.index + 1);
    openWalkScreen(`Sphere ${session.path.index + 1} saved.`);
    return;
  }
  buildSphere(session.id);
}

// ---------- Path mode: walking between spheres ----------

async function openWalkScreen(message = "") {
  $("start-error").textContent = "";
  try {
    // Needed for the compass; iOS only asks from a tap, so this must be the first await.
    if (!listening) await requestOrientationPermission();
  } catch (err) {
    $("start-error").textContent = explain(err);
    return;
  }
  walkHeadings = [];
  $("walk-saved").textContent = message;
  $("walk-heading").textContent = "Compass: hold the phone upright…";
  setWalkSteps(walkSteps);
  showScreen("walk");
}

function setWalkSteps(n) {
  walkSteps = Math.max(1, Math.min(20, n));
  $("walk-steps").textContent = walkSteps;
  $("walk-steps-text").textContent = walkSteps;
}

// Keeps the last second of compass readings while the phone is held upright, camera forward.
function trackWalkHeading() {
  const now = performance.now();
  walkHeadings = walkHeadings.filter((h) => now - h.t < HEADING_WINDOW_MS);
  const { heading, headingAccuracy } = latest;
  if (heading != null && headingAccuracy != null && headingAccuracy >= 0) {
    if (Math.abs(yawPitchFromDirection(camDir).pitch) <= 60) walkHeadings.push({ t: now, heading, accuracy: headingAccuracy });
  }
  const walk = recordedWalk();
  let text = "Compass: hold the phone upright, camera forward.";
  if (walk.headingDeg != null) {
    text = `Facing ${Math.round(walk.headingDeg)}° (${compassPoint(walk.headingDeg)})`;
    if (walk.headingAccuracyDeg > 25) text += ` · compass unsure (±${Math.round(walk.headingAccuracyDeg)}°): wave the phone in a figure 8`;
  }
  setText($("walk-heading"), text);
}

function recordedWalk() {
  const mean = new CircularMean();
  walkHeadings.forEach((h) => mean.add(h.heading));
  return {
    steps: walkSteps,
    headingDeg: mean.count ? (mean.mean() + 360) % 360 : null,
    headingAccuracyDeg: mean.count ? Math.max(...walkHeadings.map((h) => h.accuracy)) : null,
  };
}

async function captureNextOnPath() {
  pendingWalk = recordedWalk();
  await beginCapture(null);
  if (capturing) pendingWalk = null;
  else showScreen("start"); // shows why it couldn't start
}

// Stitches a session into a sphere on the phone, showing progress on the finished screen.
async function buildSphere(sessionId) {
  finishedSessionId = sessionId;
  showScreen("finished");
  const title = $("finished-title");
  const summary = $("finished-summary");
  const progress = $("stitch-progress");
  title.textContent = "Making your sphere…";
  summary.textContent = "Keep this page open.";
  progress.value = 0;
  progress.hidden = false;
  $("view-link").hidden = true;
  $("finished-retry").hidden = true;
  requestWakeLock();
  try {
    const sphere = await makeSphere(sessionId, (fraction, message) => {
      progress.value = fraction;
      summary.textContent = message;
    });
    title.textContent = "Your sphere is ready";
    summary.textContent = `${sphere.width} × ${sphere.height}, made in ${Math.round(sphere.stitchSeconds)} seconds.`;
    const link = $("view-link");
    link.href = `view.html?id=${sphere.id}&v=${VERSION.slice(1)}`;
    link.hidden = false;
  } catch (err) {
    console.error(err);
    title.textContent = "Couldn't make the sphere";
    summary.textContent = err.message;
    $("finished-retry").hidden = false;
  } finally {
    progress.hidden = true;
    releaseWakeLock();
  }
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
  if (!$("walk-screen").hidden) trackWalkHeading();
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
  if (busy || stopping || !targetsReady() || !isPortrait()) {
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
  try {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (frameCanvas.width !== vw || frameCanvas.height !== vh) {
      frameCanvas.width = vw;
      frameCanvas.height = vh;
    }
    // Compare a few consecutive frames and keep the sharpest (least motion blur), along with
    // the orientation at that moment.
    let best = -1;
    let reading = null;
    let quaternion = null;
    let timestamp = 0;
    for (let k = 0; k < BURST_FRAMES; k++) {
      if (k > 0) await nextVideoFrame();
      const score = frameSharpness(vw, vh);
      if (score > best) {
        best = score;
        frameCanvas.getContext("2d").drawImage(video, 0, 0, vw, vh);
        reading = { ...latest };
        quaternion = q;
        timestamp = Date.now();
      }
    }
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
      sharpness: best,
      framesCompared: BURST_FRAMES,
      offCenterDeg: angleBetween(cameraDirection(quaternion), targetDir(target)),
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

// Waits for the camera's next frame (or a short moment if the browser can't tell us).
function nextVideoFrame() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 60);
    video.requestVideoFrameCallback?.(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// How sharp the current video frame is: average edge strength (|Laplacian| of green) in a
// full-resolution patch from the middle of the frame. Motion blur lowers it.
function frameSharpness(vw, vh) {
  const s = SHARPNESS_PATCH;
  patchCtx.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, s, s);
  const d = patchCtx.getImageData(0, 0, s, s).data;
  let sum = 0;
  for (let y = 1; y < s - 1; y++) {
    for (let x = 1; x < s - 1; x++) {
      const i = (y * s + x) * 4 + 1;
      sum += Math.abs(4 * d[i] - d[i - 4] - d[i + 4] - d[i - s * 4] - d[i + s * 4]);
    }
  }
  return sum / ((s - 2) * (s - 2));
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
