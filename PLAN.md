# Sphere Cam — Web Proof of Concept Plan

A web app that recreates Google's old **Photo Sphere** camera: guided capture of a full 360° × 180° sphere on an iPhone, stitched into one image you can look around in and share.

**Goal of this proof of concept:** prove the capture → stitch → view pipeline works, using a PC for all coding and testing and an iPhone (Safari) only for capturing. If it works well, we'll carry what we learn into a native iOS app later.

---

## Notes for Claude Code (read first)

- **The owner has no coding experience.** Explain what you're doing in plain language, keep explanations short, and tell them exactly what to tap or click when they need to do something (on the PC, on GitHub, on the iPhone).
- **The owner codes on a PC (Windows) and tests on an iPhone in Safari.** There is no Mac.
- **Work one phase at a time.** Finish a phase, deploy it, and stop with a short "what to test on your phone" checklist before starting the next one.
- **Commit to git after each working step** so we can always roll back.
- **Keep it simple:** plain HTML, CSS and JavaScript (ES modules), no build step. Allowed libraries: **three.js** (viewer, WebGL helpers) and **JSZip** (export/import). Ask before adding anything else.
- **Show a version number** (for example "v0.3.1") in a corner of every page and bump it on each deploy, so the owner can confirm the phone has the latest version and isn't showing a cached copy.
- Anything needing the camera or motion sensors only works over **HTTPS on the real phone**. Say clearly which things can be tested on the PC and which need the phone.

---

## How the pieces fit

| Page | Runs on | Purpose |
|---|---|---|
| `capture.html` | iPhone | Guided capture with dots, auto-capture, saves sessions |
| `lab.html` (Stitch Lab) | PC (also works on phone) | Load a captured session, stitch it, tweak settings, view result |
| `view.html` | Both | Look around inside a finished sphere; save/share |
| `index.html` | Both | Simple home screen linking the above + list of saved spheres |

**Hosting:** GitHub Pages (free, HTTPS). Workflow for each change: Claude Code commits and pushes → wait ~1 minute → owner refreshes the page on the iPhone.

**Local testing on the PC:** run a simple local server (`npx serve`) and open `lab.html` / `view.html` in Chrome.

---

## Phase 0 — Setup

- Make sure git and Node.js are installed on the PC; walk the owner through installing them if not.
- Walk the owner through creating a free GitHub account (if needed) and logging in from the terminal (GitHub CLI).
- Create the repository and turn on GitHub Pages.
- Deploy a "Hello, Sphere Cam" `index.html` showing the version number.
- **Done when:** the owner opens the GitHub Pages link on their iPhone and sees the page.

## Phase 1 — Sensor check

- `capture.html` with a big **Start** button. Tapping it:
  - calls `DeviceOrientationEvent.requestPermission()` (iOS requires this from a tap),
  - starts the rear camera with `getUserMedia` (`facingMode: "environment"`, request the highest resolution available).
- Show the live camera full-screen with the current orientation numbers (alpha, beta, gamma, and `webkitCompassHeading`) overlaid, plus the actual video resolution received.
- **Done when:** on the iPhone, the camera shows and the numbers change smoothly as the phone moves.

## Phase 2 — Guided capture

- Convert device orientation to a **quaternion** (portrait mode) and use it to place **target dots** on the live preview, plus a fixed center ring.
- Capture targets (tune later):
  - Horizon ring (pitch 0°): 12 shots, every 30°
  - Upper ring (pitch +45°): 8 shots
  - Lower ring (pitch −45°): 8 shots
  - Straight up: 1 shot; straight down: 1 shot
- When a dot is inside the center ring **and** the phone has been steady for ~0.3 s, **auto-capture**: draw the current video frame to a canvas, save it as a JPEG, flash the screen, vibrate if possible, and mark the dot done.
- Save with each photo: the orientation quaternion, raw alpha/beta/gamma, the compass heading and a timestamp. Save per session: the video resolution, device info (user agent) and an estimated field of view (see Known challenges).
- Store sessions in **IndexedDB** so nothing is lost if Safari reloads.
- **Done** button (warns if dots are missing), **Undo last shot**, **Cancel**.
- **Export session:** bundle the photos and a `session.json` into a `.zip` with JSZip and open the iOS share sheet (`navigator.share` with files) so the owner can send it to their PC (email, Google Drive, OneDrive, etc.).
- **Done when:** the owner completes a full sweep on the iPhone and gets the session `.zip` onto the PC.

## Phase 3 — Stitch Lab (PC)

This is the main place to iterate, entirely on the PC.

- `lab.html`: drag-and-drop a session `.zip` to load it.
- **Synthetic test session:** also add a button that generates a fake session from a computer-generated test sphere (a colored grid with labeled directions), rendered into ~30 virtual "photos" with known orientations and field of view. This lets stitching be tested and debugged with no phone at all, and shows whether errors come from the stitcher or the phone's sensor data.
- **Stitcher v1 (orientation-based)**, WebGL:
  - Output an **equirectangular** image (2:1 ratio; start at 4096 × 2048).
  - For each output pixel: compute its 3D viewing direction → rotate into each photo's camera frame using that photo's quaternion → project using the field of view → if inside the photo, sample it.
  - **Blend** overlaps with feathered weights (stronger toward each photo's center). Accumulate one photo per pass (weighted color sum + weight sum), then normalize, to avoid WebGL texture-count limits on iPhones.
  - Fill uncaptured areas with neutral gray.
- **Tuning controls** with sliders that re-stitch live: field of view, small yaw/pitch/roll offsets for the whole set, feather width, output size. Show a "copy settings" button so good values can be saved into the code as defaults.
- Show the result as a flat image **and** in an interactive 360° view (three.js sphere, drag to look around).
- **Done when:** the synthetic test sphere stitches nearly perfectly, and a real iPhone session stitches with visible but reasonable seams.

## Phase 4 — On-phone stitching, viewer and saving

- After capture, run the same stitcher on the iPhone (start at 4096 × 2048; check speed and memory) with a progress indicator.
- `view.html`: three.js sphere viewer with drag to look around, pinch to zoom, and a toggle to look around by moving the phone.
- **Save/share** a JPEG with Google **GPano XMP metadata** inserted into the JPEG (APP1 segment), so Google Photos, Facebook, etc. recognize it as 360°:
  - `GPano:ProjectionType = equirectangular`
  - `GPano:UsePanoramaViewer = True`
  - `GPano:FullPanoWidthPixels`, `GPano:FullPanoHeightPixels`
  - `GPano:CroppedAreaImageWidthPixels`, `GPano:CroppedAreaImageHeightPixels`
  - `GPano:CroppedAreaLeftPixels = 0`, `GPano:CroppedAreaTopPixels = 0`
  - `GPano:PoseHeadingDegrees` (from compass heading of the first horizon shot)
- Saving goes through the share sheet ("Save Image" or "Save to Files"). Check whether "Save Image" keeps the metadata; if not, recommend "Save to Files" and uploading from there.
- Home screen (`index.html`) lists saved spheres with thumbnails.
- Optional: make it installable (web app manifest) so it runs full-screen from the iPhone home screen.
- **Done when:** a sphere captured and stitched entirely on the iPhone, then uploaded to Google Photos, shows up as an interactive 360° photo.

## Phase 5 — Better stitching (back in Stitch Lab)

- **Refine alignment:** find matching features in overlapping photos and adjust each photo's orientation so they line up (corrects sensor drift and field-of-view error). Ask before adding a library for this (for example OpenCV.js).
- **Brightness/color matching** between neighboring photos to hide exposure bands.
- **Seam finding + multi-band blending** to reduce ghosting from moving people.
- Bring improvements back to the phone version once they work in the Lab.
- **Done when:** seams are hard to spot in typical indoor and outdoor scenes.

## Phase 6 — Wrap-up and decision

- Write `FINDINGS.md`: best capture pattern, field-of-view values that worked, sensor quirks found, stitcher approach, and what didn't work in the browser.
- Help the owner decide: keep improving the web app, or move to a native iOS app (Swift, or Expo/React Native) using these findings.

---

## Known challenges

- **Field of view is unknown in the browser.** Safari doesn't report the lens angle. Start with an estimate for the iPhone main camera at the received video resolution and aspect ratio, tune it in Stitch Lab, and later let Phase 5 alignment estimate it automatically.
- **No exposure lock in Safari.** Photos may differ in brightness, causing bands. Handled by brightness matching in Phase 5.
- **Video-frame resolution** is lower than the Camera app's photos. Fine for a proof of concept.
- **Parallax:** the user should rotate the phone around its own lens, not swing it at arm's length. Show a tip on first launch.
- **Moving subjects** cause ghosting; Phase 5 helps but won't fully fix it.
- **Sensor drift and orientation quirks** (iOS's alpha starts at an arbitrary angle; gimbal issues when pointing straight up/down). Use quaternions, not raw angles, for all math.
- **Memory on the iPhone:** ~30 frames plus a large output can crash Safari. Downscale frames if needed and free canvases/textures promptly.
- **Safari caching:** if a change doesn't show up on the phone, check the version number and use cache-busting file names or query strings.
