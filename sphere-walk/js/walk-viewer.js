import * as THREE from "three";

const DEG = Math.PI / 180;
const SPEED = 0.8; // walking speed in meters per second
const MAX_STEP = 1; // how far you may move from where the sphere was taken, in meters
const MAX_RISE = 0.6; // and up or down

// Turns a 360° picture plus its depth map into a 3D surface: each grid point is pushed out along
// its view ray to its distance. Triangles that bridge a sudden jump in depth (a table's edge in
// front of a wall) are left out, so they don't show as stretched "rubber" sheets.
//
// World frame as in Sphere Cam (Z up, Y ahead, X right); three.js uses Y up and −Z ahead.
// edgeStrength: a jump counts as an edge when the surface would have to be closer than
// 1 / edgeStrength meters to explain it; higher cuts less.
export function buildDepthMesh({ texture, depth, width, height, scale = 1, maxColumns = 1024, cutEdges = true, edgeStrength = 10 }) {
  const step = Math.max(1, Math.ceil(width / maxColumns));
  const cols = Math.floor(width / step);
  const rows = Math.floor(height / step);
  const at = (x, y) => depth[Math.min(height - 1, y * step + (step >> 1)) * width + ((x % cols) * step + (step >> 1))] * scale;

  // Grid rows: the top pole, one row per depth row (at its center), then the bottom pole.
  // Columns run once around plus one extra that repeats the first, to close the seam behind you.
  const rowCount = rows + 2;
  const colCount = cols + 1;
  const positions = new Float32Array(rowCount * colCount * 3);
  const uvs = new Float32Array(rowCount * colCount * 2);
  const disparity = new Float32Array(rowCount * colCount); // 1 / distance, 0 if unknown
  const poleDepth = (y) => {
    let sum = 0;
    let n = 0;
    for (let x = 0; x < cols; x++) {
      const d = at(x, y);
      if (d > 0) {
        sum += d;
        n++;
      }
    }
    return n ? sum / n : 0;
  };
  const top = poleDepth(0);
  const bottom = poleDepth(rows - 1);
  for (let r = 0; r < rowCount; r++) {
    const v = r === 0 ? 0 : r === rowCount - 1 ? 1 : (r - 0.5) / rows;
    const pitch = (0.5 - v) * Math.PI;
    for (let c = 0; c < colCount; c++) {
      const u = (c + 0.5) / cols;
      const yaw = (u - 0.5) * 2 * Math.PI;
      const d = r === 0 ? top : r === rowCount - 1 ? bottom : at(c, r - 1);
      const k = r * colCount + c;
      const wx = Math.sin(yaw) * Math.cos(pitch);
      const wy = Math.cos(yaw) * Math.cos(pitch);
      const wz = Math.sin(pitch);
      positions[k * 3] = wx * d;
      positions[k * 3 + 1] = wz * d;
      positions[k * 3 + 2] = -wy * d;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = 1 - v;
      disparity[k] = d > 0 ? 1 / d : 0;
    }
  }

  // A triangle across an edge is pushed back to the far side's distance instead: seen from where
  // the sphere was taken it still fills its spot, and stepping aside shows a short stretch of the
  // background behind the edge rather than a rubber sheet hanging in the air.
  const limit = cutEdges ? edgeStrength * ((2 * Math.PI) / cols) : Infinity;
  const indices = new Uint32Array((rowCount - 1) * cols * 6);
  const extra = []; // pushed-back corners: x, y, z, u, v
  const firstExtra = rowCount * colCount;
  let n = 0;
  const add = (a, b, c) => {
    const da = disparity[a];
    const db = disparity[b];
    const dc = disparity[c];
    if (!da || !db || !dc) return; // unknown depth: leave a hole
    const far = Math.min(da, db, dc);
    if (Math.max(da, db, dc) - far <= limit) {
      indices[n++] = a;
      indices[n++] = b;
      indices[n++] = c;
      return;
    }
    for (const k of [a, b, c]) {
      const s = disparity[k] / far;
      indices[n++] = firstExtra + extra.length / 5;
      extra.push(positions[k * 3] * s, positions[k * 3 + 1] * s, positions[k * 3 + 2] * s, uvs[k * 2], uvs[k * 2 + 1]);
    }
  };
  for (let r = 0; r < rowCount - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * colCount + c;
      const b = a + 1;
      const d = a + colCount;
      const e = d + 1;
      add(a, d, b);
      add(b, d, e);
    }
  }

  const total = firstExtra + extra.length / 5;
  const allPositions = new Float32Array(total * 3);
  const allUvs = new Float32Array(total * 2);
  allPositions.set(positions);
  allUvs.set(uvs);
  for (let i = 0, k = firstExtra; i < extra.length; i += 5, k++) {
    allPositions.set(extra.slice(i, i + 3), k * 3);
    allUvs.set(extra.slice(i + 3, i + 5), k * 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(allPositions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(allUvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices.subarray(0, n), 1));
  const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
  return new THREE.Mesh(geometry, material);
}

// A picture of the depth map: near is red, then yellow, green, and far is blue (unknown is black).
// Helps judge depth estimates by eye.
export function depthColors(depth, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  const img = g.createImageData(width, height);
  const poly = (t, c) => c.reduceRight((sum, k) => sum * t + k, 0);
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (d > 0) {
      // 0.5 m → red, 8 m and beyond → blue, evenly on a log scale ("turbo" color scale).
      const t = 1 - Math.max(0, Math.min(1, Math.log(d / 0.5) / Math.log(16)));
      img.data[i * 4] = 255 * poly(t, [0.1357, 4.6154, -42.6603, 132.1311, -152.9424, 59.2864]);
      img.data[i * 4 + 1] = 255 * poly(t, [0.0914, 2.1942, 4.843, -14.185, 4.2773, 2.8296]);
      img.data[i * 4 + 2] = 255 * poly(t, [0.1067, 12.6419, -60.582, 110.3628, -89.9031, 27.3482]);
    }
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

// Walk around inside a sphere with depth, or freely through a splat scene: drag to look, pinch or
// scroll to zoom, WASD / arrow keys (or the on-screen stick) to step, Q / E to go down / up.
export class WalkViewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.style.touchAction = "none";
    container.append(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x08090a);
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.02, 200);
    this.camera.rotation.order = "YXZ";
    this.mesh = null; // the sphere's 3D surface
    this.alternate = null; // another surface shown instead (for example the true view)
    this.splat = null; // a Gaussian splat scene (from a walking video) shown instead of a sphere
    this.spark = null; // Spark, the splat renderer, loaded the first time a splat is opened

    this.yaw = 0; // degrees right of FRONT
    this.pitch = 0; // degrees above the horizon
    this.keys = new Set();
    this.stick = { x: 0, y: 0 }; // on-screen stick, each −1…1
    this.pointers = new Map();
    this.pending = false;
    this.lastTime = 0;
    this.onMove = null; // called with the camera position (three.js frame) after moving

    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  get maxTextureSize() {
    return this.renderer.capabilities.maxTextureSize;
  }

  makeTexture(source) {
    const texture = new THREE.CanvasTexture(source);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  // Replaces the sphere's surface. The old one (and its texture, unless it is reused) is freed.
  setMesh(mesh) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      if (this.mesh.material.map !== mesh?.material.map) this.mesh.material.map?.dispose();
      this.mesh.material.dispose();
    }
    this.mesh = mesh;
    if (mesh) {
      mesh.visible = !this.alternate;
      this.scene.add(mesh);
    }
    this.requestRender();
  }

  // Shows another surface in place of the sphere's (or the sphere's again when null).
  setAlternate(mesh) {
    if (this.alternate) {
      this.scene.remove(this.alternate);
      this.alternate.geometry.dispose();
      this.alternate.material.map?.dispose();
      this.alternate.material.dispose();
    }
    this.alternate = mesh;
    if (mesh) this.scene.add(mesh);
    if (this.mesh) this.mesh.visible = !mesh;
    this.requestRender();
  }

  // Shows a Gaussian splat scene instead of a sphere (or stops showing it when bytes is null).
  // Spark, the splat library, is only downloaded the first time. In a splat there's no step limit,
  // and the view redraws every frame because Spark re-sorts the splats as you move.
  async setSplat(bytes, fileName) {
    if (this.splat) {
      this.scene.remove(this.splat);
      this.splat.dispose();
      this.splat = null;
    }
    if (bytes) {
      const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
      if (!this.spark) {
        this.spark = new SparkRenderer({ renderer: this.renderer });
        this.scene.add(this.spark);
      }
      const splat = new SplatMesh({ fileBytes: bytes, fileName });
      await splat.initialized;
      this.setMesh(null);
      this.setAlternate(null);
      this.splat = splat;
      this.scene.add(splat);
    }
    this.renderer.setAnimationLoop(this.splat ? (time) => this.frame(time) : null);
    this.resetPosition();
    return this.splat;
  }

  // Many splat files are stored upside down (camera Y pointing down); this turns them over.
  setSplatFlipped(flipped) {
    this.splat?.quaternion.set(flipped ? 1 : 0, 0, 0, flipped ? 0 : 1);
    this.requestRender();
  }

  get position() {
    return this.camera.position;
  }

  resetPosition() {
    this.camera.position.set(0, 0, 0);
    this.onMove?.(this.camera.position);
    this.requestRender();
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  get moving() {
    return this.keys.size > 0 || this.stick.x !== 0 || this.stick.y !== 0;
  }

  requestRender() {
    if (this.pending || this.splat) return; // a splat redraws every frame anyway
    this.pending = true;
    requestAnimationFrame((time) => {
      this.pending = false;
      this.frame(time);
    });
  }

  frame(time) {
    const dt = this.lastTime ? Math.min(0.1, (time - this.lastTime) / 1000) : 0;
    this.lastTime = this.moving || this.splat ? time : 0;
    if (dt > 0) this.step(dt);
    this.pitch = Math.max(-89, Math.min(89, this.pitch));
    this.camera.rotation.y = -this.yaw * DEG;
    this.camera.rotation.x = this.pitch * DEG;
    this.renderer.render(this.scene, this.camera);
    if (this.moving) this.requestRender();
  }

  step(dt) {
    const k = this.keys;
    let forward = this.stick.y;
    let right = this.stick.x;
    let up = 0;
    if (k.has("KeyW") || k.has("ArrowUp")) forward += 1;
    if (k.has("KeyS") || k.has("ArrowDown")) forward -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) right += 1;
    if (k.has("KeyA") || k.has("ArrowLeft")) right -= 1;
    if (k.has("KeyE")) up += 1;
    if (k.has("KeyQ")) up -= 1;
    const yaw = this.yaw * DEG;
    const p = this.camera.position;
    const dist = SPEED * dt;
    p.x += (Math.sin(yaw) * forward + Math.cos(yaw) * right) * dist;
    p.z += (-Math.cos(yaw) * forward + Math.sin(yaw) * right) * dist;
    p.y += up * dist;
    if (!this.splat) p.y = Math.max(-MAX_RISE, Math.min(MAX_RISE, p.y));
    const flat = Math.hypot(p.x, p.z);
    if (flat > MAX_STEP && !this.splat) {
      p.x *= MAX_STEP / flat;
      p.z *= MAX_STEP / flat;
    }
    this.onMove?.(p);
  }

  setFov(fov) {
    this.camera.fov = Math.max(20, Math.min(110, fov));
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  bindInput() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    c.addEventListener("pointermove", (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      if (this.pointers.size === 1) {
        // The scene follows the finger.
        const degPerPx = this.camera.fov / c.clientHeight;
        this.yaw -= (e.clientX - prev.x) * degPerPx;
        this.pitch += (e.clientY - prev.y) * degPerPx;
        this.requestRender();
      } else if (this.pointers.size === 2) {
        const before = this.pinchDistance();
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const after = this.pinchDistance();
        if (before > 0 && after > 0) this.setFov(this.camera.fov * (before / after));
        return;
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const end = (e) => this.pointers.delete(e.pointerId);
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.setFov(this.camera.fov + e.deltaY * 0.05);
      },
      { passive: false },
    );

    const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    window.addEventListener("keydown", (e) => {
      if (!MOVE_KEYS.includes(e.code) || e.target.closest?.("input, select, textarea")) return;
      e.preventDefault();
      this.keys.add(e.code);
      this.requestRender();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.keys.clear());
  }

  // The on-screen stick: x is right, y is forward, each −1…1.
  setStick(x, y) {
    this.stick.x = x;
    this.stick.y = y;
    this.requestRender();
  }

  pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
