import { showVersion } from "./version.js?v=0.2.0";
import * as db from "../../js/db.js?v=0.7.1";
import { compassPoint } from "../../js/quat.js?v=0.7.1";
import { TARGETS } from "../../js/targets.js?v=0.7.1";

showVersion();

const $ = (id) => document.getElementById(id);
const captureUrl = (pathId) => `../capture.html?path=${pathId}&v=0.7.1`;

$("new-path").addEventListener("click", () => (location.href = captureUrl(crypto.randomUUID())));

// Captures made in path mode carry { path: { id, index, steps, headingDeg } }; group them by path.
async function showPaths() {
  let sessions = [];
  try {
    sessions = await db.listSessions();
  } catch (err) {
    console.error(err);
    $("paths-error").textContent = "Couldn't open saved captures on this device.";
  }
  const paths = new Map();
  for (const s of sessions.filter((s) => s.path)) {
    if (!paths.has(s.path.id)) paths.set(s.path.id, []);
    paths.get(s.path.id).push(s);
  }
  const list = $("path-list");
  list.replaceChildren();
  if (paths.size === 0) {
    list.innerHTML = '<p class="muted">No paths yet.</p>';
    return;
  }
  for (const [id, spheres] of paths) {
    spheres.sort((a, b) => a.path.index - b.path.index);
    const card = document.createElement("div");
    card.className = "path-card";
    const when = new Date(spheres[0].createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    card.innerHTML = `<h2></h2><ol class="path-spheres"></ol><a class="small-button"></a>`;
    card.querySelector("h2").textContent = `Path from ${when}`;
    for (const s of spheres) {
      const li = document.createElement("li");
      li.value = s.path.index + 1;
      const photos = `${s.shotCount ?? 0} / ${TARGETS.length} photos${s.status === "complete" ? "" : ", unfinished"}`;
      li.textContent = `${walkText(s.path)} · ${photos}`;
      card.querySelector("ol").append(li);
    }
    const next = card.querySelector("a");
    next.href = captureUrl(id);
    next.textContent = "Capture next sphere";
    list.append(card);
  }
}

function walkText({ index, steps, headingDeg }) {
  if (index === 0 || steps == null) return "Start";
  if (headingDeg == null) return `${steps} steps (no compass reading)`;
  return `${steps} steps toward ${compassPoint(headingDeg)} (${Math.round(headingDeg)}°)`;
}

showPaths();
