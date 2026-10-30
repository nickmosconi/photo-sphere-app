# Sphere Walk — Proof of Concept Build Plan

Oct 29, 2026 · Nick · Live version of this plan: https://claude.ai/artifact/MCUTcAchg9mzUVaeV6efFh

## Overview

Sphere Walk is the next step after Sphere Cam: instead of only turning in one spot, you can walk smoothly through a place you captured. It's a branch in the `sphere-walk` subfolder of `photo-sphere-app` and reuses Sphere Cam's capture, stitching and viewer.

**The core idea:** a sphere has no depth, so an AI model estimates how far away every pixel is. Each sphere then becomes a small 3D scene (a Gaussian splat). Capture several spheres a few steps apart, place them where they were taken, and the viewer glides between them.

**Two paths, tested side by side:**

- **Path A — spheres + AI depth.** Uses the capture you already have. The main path for this proof of concept.
- **Path B — walking video → splat.** Record a slow walk and turn it into a 3D scene. Smoother movement, but a different capture style. Tested in Stage 5 to compare.

**Bonus:** a World Builder connector, where anyone uploads a sphere or scene and an AI world model fills in what the camera never saw and extends it into a bigger virtual world.

Everything ends up in one viewer, so spheres, walking-video scenes and AI-built worlds all open the same way.

## How it works

```
Path A · spheres + AI depth:  Capture spheres (Stage 2) → AI depth per sphere (Stage 1)
                              → Place and align (Stage 2) → Fill the gaps (Stage 4) → splats
Path B · walking video:       Walking video → Make a splat (Stage 5) → splat
Bonus · World Builder:        Upload anything → AI world model → Generated world → splat world
All three feed one viewer:    Sphere Walk viewer, Spark on three.js (Stage 3)
```

Path A is the proof of concept's main line; Path B and the World Builder plug into the same viewer, so nothing built in Stages 1–4 is wasted whichever path wins.

## Set up the branch

The subfolder exists with a README; this plan is saved beside it as `PLAN.md` so Claude Code can read it.

- [x] Create `photo-sphere-app\sphere-walk` with a README
- [ ] **Quick look first (15 minutes, free):** upload one of your Sphere Cam spheres to World Labs' Marble on its free plan and walk around the result. It shows what "walkable from one sphere" can look like before you build anything.
- [x] Check whether your PC has an NVIDIA graphics card (Claude Code can check). It decides how fast depth and splat steps run locally. **Result (Oct 29): no.** Intel UHD integrated graphics, i7-1255U, 16 GB RAM, Python 3.9 only. Depth runs on the processor (seconds to a minute per sphere); making splats from video needs an app, a paid service or the Mac.
- [ ] Open Claude Code in the `photo-sphere-app` folder (not the subfolder) and paste the prompt below

**First prompt:**

```
Read PLAN.md and QUALITY.md in this folder, then sphere-walk/README.md and sphere-walk/PLAN.md.
We're starting the Sphere Walk branch in sphere-walk/: walking smoothly through captured places.
Same rules as Sphere Cam: plain HTML/CSS/JS in the browser, explain in plain English,
commit after each working step, version number on every page.
Import shared code from ../js/ instead of copying it. Don't change how Sphere Cam's pages behave.
New for this branch: a small Python tool on my PC for AI depth (keep it in sphere-walk/tools/,
keep model files out of Git), and ask me before adding any new browser library.
Check my PC's graphics card, then start Stage 1. Tell me your plan first.
```

**Hosting:** GitHub Pages already serves the whole repo, so the viewer will be live at your Sphere Cam address plus `/sphere-walk/`. Stay on the main Git branch so it keeps deploying.

**A Mac is coming:** you're getting a Mac to build and test a native iOS app. Until it arrives, keep all web work runnable from the PC. Once it's here, native work (Xcode, running on your iPhone, TestFlight) happens on the Mac, and its Apple Silicon chip can also run DAP's Core ML depth model locally.

## Stage 1: Depth from one sphere

Prove that one sphere can become a small 3D space you can lean and step around in. Everything else builds on this.

1. **Test room with known depth.** Extend Sphere Cam's synthetic test scene into a simple 3D room (walls, a table, a doorway) so depth results can be checked against the truth, with no phone needed.
2. **AI depth on the PC.** A Python tool runs a 360° depth model on a stitched sphere and saves a depth map next to it. Good open candidates: [Depth Any Panoramas (DAP)](https://huggingface.co/pearsonkyle/DepthAnyPanorama-coreml) and [ORB](https://huggingface.co/speridlabs/orb), both Apache-licensed and built for equirectangular images. These models are around 1.2–1.3 GB, so they run on the PC, not in iPhone Safari.
3. **Real-world scale.** Depth models guess relative distance. Fix the scale from the phone's height above the floor during capture (measure it once, e.g. chest height).
4. **3D viewer.** Turn the sphere plus depth into one splat per pixel and show it with [Spark](https://github.com/sparkjsdev/spark), World Labs' free (MIT) splat renderer built for three.js, which Sphere Cam already uses. Let you move about a meter in any direction.

**Starter prompt:**

```
Build Stage 1 of sphere-walk/PLAN.md. Start with the synthetic 3D test room,
then the Python depth tool, then the viewer. Compare DAP and ORB on the test room and on
one real sphere, and tell me which looks better and how long each takes on my PC.
```

**Progress (v0.1.0, Oct 29):**

- Done: the synthetic test room (`js/room.js`: two rooms joined by a doorway, a table, stool, cabinet, posters, 50 cm floor tiles) with exact depth, drawn in a background worker.
- Done: the walking viewer (`index.html`) in plain three.js: the sphere becomes a 3D surface pushed out by depth, you can step up to 1 m with WASD/arrow keys or the on-screen stick, edges are cut where depth jumps, a "true view from here" toggle for the test room, depth-as-colors, and scaling from phone height (floor found straight down).
- Depth files are PNGs holding millimeters (red × 256 + green), written by the browser and, later, the Python tool.
- Spark is not used yet: a mesh in three.js (already allowed) does the job for one sphere. Revisit for Stage 3 or when loading splat files.
- **Model findings:** ORB's Hugging Face page and GitHub are no longer public. Its open base, [DA²](https://github.com/EnVision-Research/DA-2) (Apache-2.0, 1.4 GB, relative depth), is the stand-in. **DAP's licence is CC BY-NC 4.0 (no commercial use)**, not Apache. Both need Python 3.10 or newer. Small fallback: [DA360](https://github.com/Antigravity-Tech/DA360) (small model about 100 MB).
- Next: the Python depth tool in `tools/` (needs a newer Python and about 3 GB of downloads).

**Done when:**

- [ ] Depth on the synthetic room is close to the true distances
- [ ] In a real sphere on your iPhone, stepping half a meter sideways makes near objects shift in front of far ones
- [ ] The floor looks flat and at the right height

## Stage 2: Capture a path of spheres

Capture several spheres a few steps apart and work out where each one was taken. Safari can't track the phone's position, so this starts manual and gets automatic.

1. **Path mode in capture.** After each sphere, the app says "take 3 steps forward, then capture the next one" and records the step count and compass direction (Sphere Cam already saves the heading).
2. **Rough placement.** A top-down map shows each sphere as a dot placed from steps and heading; you can drag a dot to fix it.
3. **Automatic refinement.** Line up neighboring spheres by matching their 3D points where they overlap, the same idea as Sphere Cam's photo alignment but in 3D.
4. **One shared floor.** Put every sphere at the same eye height above one floor so walking doesn't bob up and down.

**Starter prompt:**

```
Build Stage 2 of sphere-walk/PLAN.md: a path mode in capture that records steps and heading
between spheres, a top-down map to place and drag them, then automatic 3D alignment between neighbors.
Add path mode without changing Sphere Cam's normal capture.
```

**Done when:**

- [ ] Four spheres captured along a hallway into a room appear in the right places on the map
- [ ] Viewed together, the walls from neighboring spheres line up within a few centimeters

## Experiment: capture without the dots

Test whether people can just turn the phone around them while the app picks the photos itself. Fewer rules means less friction, which matters more when Sphere Walk needs several spheres per place.

**Can the app choose the frames?** Yes. It records the camera continuously with each frame's direction, then keeps the sharpest frame for each patch of the sphere and drops blurry or duplicate ones. Sphere Cam already picks the sharpest frame and aligns photos by their content, so much of this exists.

1. **Free sweep mode.** Replace the dots with a live coverage map: the sphere fills in wherever you've pointed, so you see the gaps instead of chasing targets.
2. **Automatic frame picking.** For each area, keep the sharpest frame that overlaps enough with its neighbors to stitch.
3. **Coach only when needed.** "Slow down" when frames blur, "turn the phone, don't swing it" when it moves sideways, "point up" when the ceiling is missing.
4. **Finish anytime.** Stitch what's covered, fill small missing patches, and warn about big ones.
5. **A/B test.** Capture the same room both ways and compare time, retries, seams and ghosting. Have someone who has never used the app try both.

**Watch for:** more blur from fast turning, missed spots straight up and down, and more ghosting if people swing the phone at arm's length.

**Starter prompt:**

```
Add an experimental free sweep capture mode (no dots) to the shared capture code, behind a toggle
so Sphere Cam's dot mode stays the default. Record frames with their direction, show a coverage map,
and automatically pick the sharpest well-spaced frames for stitching. Then help me A/B test it
against dot mode.
```

**Done when:**

- [ ] A full sphere can be captured with no dots, just by turning around
- [ ] A first-time user finds free sweep faster or easier, with seams no worse than dot mode
- [ ] FINDINGS.md records the decision: keep dots, switch to free sweep, or offer both

## Stage 3: Smooth walking between spheres

This is the payoff: glide from one end of the path to the other without jumps.

1. **Controls.** On the PC: arrow keys or WASD plus mouse drag. On the iPhone: drag to look, an on-screen joystick or tap a spot on the floor to glide there, plus Sphere Cam's move-the-phone look mode.
2. **Blend nearby spheres.** Show the splats of the two or three closest spheres and fade between them by distance, so detail comes from whichever sphere is nearest.
3. **Stay where it looks good.** Limit walking to a corridor around the captured path; quality drops fast far from any sphere.
4. **Speed on the iPhone.** Load only nearby spheres, shrink far ones, and aim for smooth motion on your phone.

**Starter prompt:**

```
Build Stage 3 of sphere-walk/PLAN.md: walking controls for PC and iPhone,
blending the nearest spheres by distance, and a walkable corridor along the path.
Measure frame rate on my iPhone and tell me what limits it.
```

**Done when:**

- [ ] You can walk the 4-sphere path on your iPhone with no visible jumps between spheres
- [ ] It feels smooth on your phone, not stuttery
- [ ] Someone who didn't capture it can find their way from start to end

## Stage 4: Fill the gaps

When you step sideways, you see spots no sphere captured, like behind a couch or around a doorframe. Without a fix they show as stretched smears or holes.

1. **Cut the smears.** Split the 3D surface wherever depth jumps sharply (an object's edge) instead of stretching across it.
2. **Borrow from neighbors.** Fill a hole from another sphere that did see that spot; this works only because of Stage 2's alignment.
3. **AI fill for the rest.** For spots no sphere saw, use an AI inpainting model to paint them in, then give that paint depth. Tencent's open [HunyuanWorld](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0) includes a panorama inpainting model to try.
4. **Mark what's real.** Keep a flag on AI-filled areas so the viewer can show or hide them.

**Starter prompt:**

```
Build Stage 4 of sphere-walk/PLAN.md. First cut stretched surfaces at depth edges and fill from
neighboring spheres. Then test one AI inpainting model on my PC for what's left; tell me its
size, speed and licence before we commit to it.
```

**Done when:**

- [ ] Walking the path in a normal room shows no obvious tears or rubbery smears
- [ ] A toggle shows which areas were filled by AI

## Stage 5: Walking-video splat experiment, then decide

Capture the same space a second way and compare honestly before refining either.

1. **Record.** A slow, steady walking video through the same rooms as Stage 2 (main camera, no zoom, good light).
2. **Make a splat.** Try one of: your PC (only practical with an NVIDIA card), a phone app that builds splats, or Marble's video input.
3. **Load it in Sphere Walk.** Spark reads the common splat formats (PLY, SPZ and others), so it opens in the same viewer.
4. **Compare side by side.** Smoothness, sharpness, holes, capture time, processing time and cost.
5. **Write `sphere-walk/FINDINGS.md`** with the winner, or a mix (for example video splat for the walk, spheres for sharp look-around spots).

**Starter prompt:**

```
Stage 5 of sphere-walk/PLAN.md: help me turn a walking video into a Gaussian splat using
the cheapest option for my PC, load it in our viewer, and build a side-by-side comparison
with the sphere path from Stage 3.
```

**Done when:**

- [ ] The same rooms can be walked both ways in the same viewer
- [ ] FINDINGS.md says which path to refine next and why

## Bonus: World Builder connector

Let anyone upload a sphere, a set of spheres, a splat or a walking video, send it to an AI world model that fills in what the camera never saw, and get back a bigger world to explore in Sphere Walk. The tools to do this exist today.

| Option | Takes | Gives back | Cost and licence |
| --- | --- | --- | --- |
| [World Labs Marble + World API](https://www.worldlabs.ai/blog/announcing-the-world-api) | Text, a photo, a 360° panorama, 2–8 photos, or a walkthrough video | A Gaussian splat world (PLY export), plus meshes | Free plan with a few worlds; API about $1.20–1.28 per world ([summary as of Aug 2026](https://invideo.io/blog/world-labs-marble-3d-worlds/)) |
| [Tencent HunyuanWorld](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0) | Text or an image, turned into a panorama first | A layered 3D world with mesh export | Free to download; licence has use limits; needs a strong GPU to run yourself |

**How the connector works:**

1. **One shape for every provider.** Sphere Walk asks for a world with the same request every time (input files, a text hint like "extend into a garden", how far to extend) and gets a splat file back. Each provider gets a small adapter, so you can switch or add providers later.
2. **A tiny server for keys.** API keys can't live on GitHub Pages, so a small server function holds the key, sends the job and waits for the result.
3. **Real center, AI edges.** Place your captured spheres inside the generated world, so the part you photographed stays true and the AI only fills around it. Reuse Stage 4's flag to show what's generated.
4. **An MCP connector.** Expose the same request as an MCP server ("make a world from this sphere"), so Claude or other AI tools can send uploads and get worlds back. This fits your app studio idea.
5. **Upload page and gallery.** Anyone drops in a sphere or video, picks a style, and gets a shareable link.

**Steps:**

- [ ] Manual test: one Sphere Cam sphere → Marble → export PLY → open in Sphere Walk's viewer
- [ ] Build the adapter and server function for one provider, with a cost cap per day
- [ ] Combine real spheres with a generated world
- [ ] Wrap it as an MCP connector

**Starter prompt (after Stage 3 works):**

```
Read the World Builder section of sphere-walk/PLAN.md. Design a provider-neutral "make a world"
request, then build the first adapter for World Labs' World API with a small server function that
keeps my API key secret. Ask me before creating any accounts or spending money.
```

## How to work with Claude Code on this

The habits that got Sphere Cam to v0.6 still apply; these matter most for this branch.

- **One stage, one feature per session.** Ask for a plan first, then let it build. Start a fresh session between features.
- **Protect the original.** End every session with: "Check that Sphere Cam's main pages still work."
- **Shared vs. branch code.** Improvements to capture, stitching or the viewer go in `js/`; walking, depth and world-building go in `sphere-walk/`.
- **Test on the synthetic room first**, then a real capture. It tells you whether a problem is the code or the photos.
- **Keep big files out of Git.** AI models and test outputs stay in ignored folders; only code and small samples get committed.
- **Check the version number** on your phone before reporting a bug, and paste screenshots of anything that looks wrong.
- **Keep this plan current.** When a decision changes, ask Claude Code to update `sphere-walk/PLAN.md`.

## Risks, open questions and what comes after

- **Does your PC have an NVIDIA card?** Without one, depth still works but more slowly, and making splats from video goes to an app, a paid service, or your Mac once it arrives.
- **Ghosting gets worse when you walk.** Sphere Cam's quality review found parallax doubles near objects; walking makes them more visible, so steady rotation around the lens matters more.
- **Position accuracy.** Safari can't track where the phone is; if Stage 2 alignment isn't good enough, positions stay manual until a native app.
- **iPhone speed.** Several large splats at once may be too heavy; Stage 3 measures it early.
- **AI fills things in.** Generated areas look real but aren't; always keep them marked.
- **Licences and costs.** Check each model's licence before using it in something you sell, and cap World Builder spending.

**After the proof of concept:** refine the winning path from Stage 5. A native iPhone app, built in Xcode on your new Mac, then removes the biggest limits: ARKit tracks where the phone is (solving Stage 2), LiDAR gives real depth on Pro iPhones, and DAP already has an [iOS version](https://huggingface.co/pearsonkyle/DepthAnyPanorama-coreml) that runs on the phone.

**Sources:** [World API announcement](https://www.worldlabs.ai/blog/announcing-the-world-api) · [Marble overview and pricing](https://invideo.io/blog/world-labs-marble-3d-worlds/) · [HunyuanWorld](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0) · [Spark](https://github.com/sparkjsdev/spark) · [DAP](https://huggingface.co/pearsonkyle/DepthAnyPanorama-coreml) · [ORB](https://huggingface.co/speridlabs/orb)
