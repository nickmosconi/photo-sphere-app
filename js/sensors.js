import { showVersion } from "./version.js?v=0.7.0";

showVersion();

const startScreen = document.getElementById("start-screen");
const startButton = document.getElementById("start-button");
const startError = document.getElementById("start-error");
const video = document.getElementById("camera");
const readout = document.getElementById("readout");

// Latest values from the motion sensors; updated on every deviceorientation event.
const latest = {
  alpha: null,
  beta: null,
  gamma: null,
  heading: null,
  headingAccuracy: null,
};

let stream = null;
let listening = false;
let eventCount = 0;
let eventRate = 0;
let readoutRunning = false;
let motionProblem = "";

startButton.addEventListener("click", start);

async function start() {
  startError.textContent = "";
  startButton.disabled = true;
  try {
    if (!window.isSecureContext) throw new Error("NOT_SECURE");
    // iOS only shows the motion prompt when asked directly from a tap, so ask before anything else.
    // A refusal isn't fatal: the camera still starts and the problem is shown in the readout.
    try {
      await requestOrientationPermission();
      motionProblem = "";
    } catch (err) {
      console.error(err);
      motionProblem = explain(err);
    }
    await startCamera();
    startScreen.hidden = true;
    if (!readoutRunning) {
      readoutRunning = true;
      requestAnimationFrame(updateReadout);
    }
  } catch (err) {
    console.error(err);
    startError.textContent = explain(err);
  } finally {
    startButton.disabled = false;
  }
}

async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent === "undefined") throw new Error("NO_ORIENTATION");
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    const result = await DeviceOrientationEvent.requestPermission();
    if (result !== "granted") throw new Error("MOTION_DENIED");
  }
  if (!listening) {
    window.addEventListener("deviceorientation", onOrientation);
    listening = true;
    setInterval(() => {
      eventRate = eventCount;
      eventCount = 0;
    }, 1000);
  }
}

function onOrientation(e) {
  latest.alpha = e.alpha;
  latest.beta = e.beta;
  latest.gamma = e.gamma;
  latest.heading = e.webkitCompassHeading ?? null;
  latest.headingAccuracy = e.webkitCompassAccuracy ?? null;
  eventCount++;
}

async function startCamera() {
  if (stream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("NO_CAMERA_API");
  // Ask for a large frame; the browser picks the closest size the camera supports.
  // "ideal" (not "exact") so a PC webcam still works for testing.
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 4032 },
      height: { ideal: 3024 },
    },
  });
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", cameraStopped);
  video.srcObject = stream;
  await video.play();
}

// Safari can stop the camera when the app goes to the background.
function cameraStopped() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  startError.textContent = "The camera stopped. Tap Start to turn it back on.";
  startScreen.hidden = false;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !stream) return;
  if (stream.getVideoTracks()[0]?.readyState === "ended") cameraStopped();
});

// A capability is a list of choices, a {min, max} range, or a plain value.
function describeCapability(value) {
  if (Array.isArray(value)) return value.join("/") || "—";
  if (value && typeof value === "object" && "min" in value) return `${value.min}–${value.max}`;
  return String(value);
}

function updateReadout() {
  const track = stream?.getVideoTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  const caps = track?.getCapabilities?.() ?? {};

  const heading =
    latest.heading == null
      ? "—"
      : `${fmt(latest.heading)}°` +
        (latest.headingAccuracy == null ? "" : ` (±${Math.round(latest.headingAccuracy)}°)`);

  const lines = [
    `alpha  (turn)       ${fmtDeg(latest.alpha)}`,
    `beta   (tilt fwd)   ${fmtDeg(latest.beta)}`,
    `gamma  (tilt side)  ${fmtDeg(latest.gamma)}`,
    `compass             ${heading}`,
    `updates/sec         ${eventRate}`,
    "",
    `video    ${video.videoWidth} × ${video.videoHeight}`,
    `fps      ${settings.frameRate ? Math.round(settings.frameRate) : "—"}`,
    `max      ${caps.width?.max ?? "?"} × ${caps.height?.max ?? "?"}`,
    `camera   ${(track?.label || "—").slice(0, 30)}`,
  ];
  if (track) {
    // Camera settings the browser lets a page change, e.g. whether exposure can be locked.
    const basic = ["width", "height", "aspectRatio", "frameRate", "deviceId", "groupId", "facingMode", "resizeMode"];
    const extras = Object.entries(caps)
      .filter(([key]) => !basic.includes(key))
      .map(([key, value]) => `${key}: ${describeCapability(value)}`);
    lines.push("", "adjustable:", ...(extras.length ? extras.flatMap((e) => wrap(e, 40)) : ["none"]));
  }
  if (motionProblem) {
    lines.push("", ...wrap(motionProblem, 40));
  } else if (eventRate === 0 && latest.alpha == null) {
    lines.push("", "No motion data (normal on a PC).");
  }
  readout.textContent = lines.join("\n");
  requestAnimationFrame(updateReadout);
}

// The readout is preformatted text, so long messages need manual line breaks.
function wrap(text, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fmt(n) {
  return n.toFixed(1);
}

function fmtDeg(n) {
  return n == null ? "—" : `${fmt(n).padStart(6)}°`;
}

function explain(err) {
  switch (err?.message || err?.name) {
    case "NOT_SECURE":
      return "This page must be opened with an https:// link.";
    case "NO_ORIENTATION":
      return "This browser doesn't provide motion data.";
    case "MOTION_DENIED":
      return "Motion access was not allowed. Fully close Safari (swipe it away), open this page again, tap Start and choose Allow.";
    case "NO_CAMERA_API":
      return "This browser can't use the camera.";
  }
  switch (err?.name) {
    case "NotAllowedError":
      return "Camera access was blocked. In Safari, tap the \"aA\" button in the address bar → Website Settings → Camera → Allow, then tap Start again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found.";
    case "NotReadableError":
      return "The camera is busy in another app. Close that app and try again.";
  }
  return `Something went wrong: ${err?.message || err}`;
}
