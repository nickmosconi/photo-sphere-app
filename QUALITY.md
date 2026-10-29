# Sphere Cam: quality assessment

Assessed on 2026-10-28 at version v0.5.0, using the first real 30-photo capture (indoor living room, evening light, iPhone Pro "Back Camera", 3024 × 4032 frames).

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
2. **The Stitch Lab can't use full-size photos.** It keeps all 30 photos on the graphics card (about 2 GB at full size), which fails silently. Open; fix by using the one-photo-at-a-time path.
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
