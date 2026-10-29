# Sphere Cam: quality assessment

Assessed on 2026-10-28 at version v0.5.0, using the first real 30-photo capture (indoor living room, evening light, iPhone Pro "Back Camera", 3024 × 4032 frames).

**Update (v0.6.0):** quick fixes 1–4 below are done: bigger spheres, shooting tips, sharpest-frame capture, and a readout of the camera's adjustable settings. See "Progress" at the end.

## Summary

- **The biggest quality loss is the size of the finished sphere, not the camera.** The camera frames hold about 59 pixels per degree; the 4096-wide sphere keeps about 11. A phone screen in the viewer shows about 23 pixels per degree, so every sphere pixel is stretched about 2× when you look at it. That is why spheres look soft even where the stitching is perfect.
- **Ghosting now comes mostly from parallax**, meaning near objects shift between photos because the phone moves, not just turns. Content-based alignment fixed the sensor errors (overlaps went from 1.45° apart to 0.19°); parallax can't be fixed by turning photos.
- **The web camera has real limits.** Photos are frames from the video stream: no Smart HDR or Deep Fusion, no exposure or white-balance lock, and video-style noise reduction. These are the main reasons to consider a native app later.
- **Solid parts:** guided capture, automatic shots, saving on the phone, alignment, brightness and vignetting matching, the 360° viewer, and 360° photo tags in saved JPEGs.

## 1. Where detail is lost

| Stage | Size | Pixels per degree | Kept vs camera |
|---|---|---|---|
| Camera frame (68° across the long side) | 3024 × 4032 | 59 | 100% |
| Photos as fed to the stitcher (scaled to 2048) | 1536 × 2048 | 30 | 51% |
| **Finished sphere today** | **4096 × 2048** | **11.4** | **19%** |
| Possible on iPhone Safari (largest canvas it allows) | 5792 × 2896 | 16 | 27% |
| Possible on PC, or on iPhone with strip-by-strip stitching | 8192 × 4096 | 22.8 | 38% |
| Needed to look sharp on an iPhone screen in the viewer | about 8200 wide | about 23 | |

A side-by-side test on the same patch of a painting showed the 8192-wide sphere is clearly sharper than today's 4096 one. Made from full-size photos, it took 6 seconds on the PC.

## 2. Other image-quality factors

| Factor | What was measured | Effect | Status |
|---|---|---|---|
| Source frames | Fine texture is visible at 100%; flat areas are very clean (noise about 1 level out of 255), so heavy video noise reduction | Good enough for a proof of concept, but softer than Camera-app photos | Web limit |
| Light | Floor areas were 8–23 out of 255 (very dark, evening indoor light) | Dark, flat-looking shadows | Shooting conditions |
| Exposure | The iPhone changed exposure per shot: gains of 0.7–1.9 needed (largest facing the windows) | Patchy brightness, clipped windows | Corrected after capture; can't lock exposure on the web (unconfirmed) |
| Vignetting | About 15% darker in photo corners | Curved bands on walls and ceiling | Corrected (v0.4.1) |
| Sensor orientation error | Overlaps 1.45° apart | See-through doubles | Fixed by alignment: 0.19° (v0.5.0) |
| Parallax | Near objects (ceiling fan, fireplace, TV) shift between photos | Remaining ghosts and steps | Needs better shooting technique or seam finding |
| Motion blur | No check at capture time | Some photos may be soft | Not handled yet |
| Field of view | 68° measured from overlaps (was guessed at 70°) | Misplaced edges if wrong | Done |
| Blending | Nearest-photo weighting; two-band blending was tried and made it worse (dark smears off near objects) | | Done; two-band rejected |
| JPEG quality | 0.90 per photo, 0.92 for the sphere | Not a limiting factor | OK |

## 3. Product assessment by area

Scores out of 5 for a proof of concept.

| Area | Score | Strengths | Weaknesses |
|---|---|---|---|
| Capture | 4 | Clear dots and ring, auto-capture, main lens forced, pause and resume, about 70 s per sphere | No sharpness check, no parallax coaching, portrait only, compass-based resume not yet tried on the phone |
| Stitching | 3 | Accurate alignment, brightness and vignetting matching, works one photo at a time on the phone | Low output size; parallax ghosting; no seam finding; rotation-only model |
| Viewer | 4 | Drag, pinch, move-the-phone mode, full screen | Shows the low-resolution sphere |
| Saving and sharing | 3 | Correct 360° (GPano) tags inside the JPEG, share sheet, list on home page | Not yet confirmed that Google Photos shows it as 360°; unknown whether "Save Image" keeps the tags |
| Reliability and testing | 2 | Synthetic test scene; every phase tested on the PC | No automated tests; 8192 output was silently broken from Phase 3 until this review; phone speed and memory never measured |
| Code and upkeep | 3 | Small, plain modules (about 3,000 lines), no build step, everything in git | 58 version strings to bump by hand per release; projection math repeated in four files |
| Privacy and security | 4 | Photos stay on the phone; no accounts, keys or tracking; library versions pinned | Repository is public (code only); libraries load from a CDN without integrity checks |
| Performance | 3 (PC only) | Make sphere 9 s on the PC | iPhone time and memory unmeasured; about 70 MB stored per capture with no storage readout |

## 4. Bugs found during this review

1. **8192-wide output came out blank.** On the first stitch, the output buffer was created after the float buffer had been bound for reading, which unbound it and made the final pass read from what it was drawing into. Fixed in v0.5.1.
2. **The Stitch Lab can't use full-size photos.** It keeps all 30 photos on the graphics card (about 2 GB at full size), which fails silently. Fixed in v0.6.0: the Lab keeps photos at 2048 (30 pixels per degree, enough for 8192-wide output), and the stitcher now reports graphics errors instead of returning a blank image.
3. **Still unverified on the iPhone:** how long Make sphere takes and whether memory holds up; Google Photos recognizing the 360° photo; resuming a paused capture.

## 5. How to get higher-quality spheres

Ranked by gain for the effort.

### Quick (web app, about one session each)

1. **Bigger spheres.** Phone: 5792 × 2896, the largest image iPhone Safari can make, about 1.4× sharper. PC Lab: 8192 × 4096, about 2× sharper. Feed full-size photos into the stitcher.
2. **Shoot to avoid parallax.** Turn the phone around its lens rather than around your body: hold it close to your eye and pivot on the spot, or use a selfie stick or tripod. Keep near objects at least 1.5–2 m away, and shoot in good light. Add an on-screen tip.
3. **Sharpest-frame capture.** While you hold still, grab about 4 frames and keep the sharpest, or average them to cut noise.
4. **Check for exposure lock.** Show the camera's adjustable settings in Sensor check to find out whether Safari allows locking exposure and white balance.

### Medium

5. **8192 × 4096 on the iPhone** by stitching in strips and writing the JPEG in pieces. Needs a small JPEG-encoding library (for example jpeg-js); the plan says to ask first.
6. **Seam finding:** place each join where the overlapping photos agree, which keeps joins out of near objects.
7. **Lens model:** let alignment fine-tune the field of view and lens distortion.

### Big: a native iPhone app

Gives Camera-app quality photos (Smart HDR, Deep Fusion, 24 or 48 MP), locked exposure, focus and white balance, exact lens data, and no browser memory limits. Swift needs a Mac; Expo or React Native with cloud builds works from a Windows PC. This is the Phase 6 decision.

### Expected result

| Step | Sharpness | Ghosting | Colour and brightness |
|---|---|---|---|
| 1. Bigger spheres | ++ | | |
| 2. Shooting technique | + | ++ | + (good light) |
| 3. Sharpest frame | + | | + (less noise) |
| 4. Exposure lock (if Safari allows) | | | ++ |
| 6. Seam finding | | + | |
| Native app | +++ | | +++ |

## 6. Recommendation

Do steps 1–3 next, since together they address most of what looks "low quality". Then measure Make sphere time on the iPhone and confirm Google Photos shows the result as 360°. With those results, Phase 6 can weigh the remaining web limits against building a native app.

## Progress

### v0.6.0 (2026-10-28)

| Step | What changed | Tested on the PC |
|---|---|---|
| 1. Bigger spheres | The phone makes 5792 × 2896 spheres (was 4096 × 2048) from photos scaled to 3072 (was 2048). If the phone runs out of memory, it falls back to 4096 automatically. The Lab offers 5792 and 8192. | Living room: 5792 × 2896, 2.5 MB, 23 s on the PC (was 9 s at 4096). Clearly sharper side by side. Forcing a failure fell back to 4096 correctly. |
| 2. Shooting tips | The capture start screen shows a picture (turn the phone around its camera, not at arm's length around you) and three tips: turn the phone not your body, keep near things 2 steps away, use good light. | Picture rendered and checked. |
| 3. Sharpest frame | Each photo compares 4 consecutive camera frames (sharpness of a full-resolution patch in the middle) and keeps the sharpest, with the orientation at that moment. The score is saved with the photo. | Fake camera alternating blurry and sharp frames: the sharp one was kept. |
| 4. Exposure lock check | Sensor check lists the camera settings Safari lets a page change (for example exposureMode, whiteBalanceMode). | Listing checked with a simulated camera; the real list needs the iPhone. |
| Reliability | The stitcher now stops with an error on graphics failures (lost context, WebGL errors, canvas too big) instead of producing a blank sphere. | 8192 blank-output bug would now be caught. |

Still to check on the iPhone: Make sphere time and memory at 5792, what Sensor check lists under "adjustable", whether sharpest-frame capture slows the sweep, and Google Photos showing the result as 360°.

### v0.6.1 (2026-10-28): iPhone crash fix

On the iPhone, v0.6.0 crashed after capturing ("A problem repeatedly occurred"), meaning Safari killed the page for using too much memory. Making a 5792-wide sphere in one go needed roughly 400–450 MB; the 4096 version that worked in v0.4.0 needed about 250 MB.

| Change | Memory effect |
|---|---|
| Big spheres are stitched in 2 horizontal strips; photos that can't reach a strip are skipped for it | Float buffer and drawing canvas halved (about 200 MB less); 52 photo reads instead of 30 |
| Photos for stitching back to 2048 (from 3072); still 30 pixels per degree, about twice what a 5792 sphere holds | About 20 MB less per photo |
| Capture's 12-megapixel photo buffer freed before stitching; alignment copies stored as bytes, not floats | About 48 MB + 44 MB less |
| Photos decoded straight to the smaller size where Safari supports it | Avoids a 48 MB full-size copy per photo |
| Crash recovery: progress is written down while making a sphere; if the page reloads with it still there, the app says which step crashed and uses 4096 from then on | Prevents repeated crashes |

Tested on the PC: two strips match one pass (mean difference 0.001 out of 255); a 5792 sphere takes 30 s; a simulated crash showed the message and the next sphere was made at 4096. Still unverified: whether 5792 now fits in the iPhone's memory.

### v0.7.0 (2026-10-28): 8192-wide spheres on the phone

| Change | Details | Tested on the PC |
|---|---|---|
| 8192 × 4096 spheres | Made in 4 strips; each finished strip goes straight into Sphere Cam's own JPEG encoder (js/jpeg-encoder.js), so the 33-megapixel image never has to fit in a canvas (Safari's limit is about 16.7 million pixels). About 200 MB at most. Falls back to 5792, then 4096, after a crash. | 8192 × 4096 sphere, 5.3 MB, 62 s on the PC |
| JPEG encoder | Baseline JPEG, 4:2:0, standard tables, written a band of rows at a time; no library | Same quality as the browser's encoder at 92 (38.05 vs 38.06 dB on a test image); files about 30% larger |
| Viewer halves | Big spheres also store left and right halves (4096 × 4096 each) that the viewer shows as two parts of the sphere; the full image is what Save / Share sends | Joins between halves invisible (checked straight ahead and behind) |
| Fewer, faster photo reads | Each strip skips photos whose traced edges can't reach it; strips decode 2048-pixel copies made in the first pass instead of the 12-megapixel originals | 58 reads; strips 2–5 s each instead of 13–18 s |
| Light sharpening | Unsharp mask over each 3×3 neighborhood when finishing the sphere; strength 0.6 (1.2 looked gritty). Adjustable in the Lab. | Visibly crisper brush marks |

Still unverified on the iPhone: time to make an 8192 sphere (the PC needs about a minute; saving each 2048 copy was slow in the PC test browser) and whether it stays within memory.
