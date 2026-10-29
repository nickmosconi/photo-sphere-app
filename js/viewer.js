import * as THREE from "three";
import { cameraDirection, fromDeviceOrientation, yawPitchFromDirection } from "./quat.js?v=0.4.0";

const DEG = Math.PI / 180;

// Interactive 360° view of an equirectangular image (a canvas or image):
// drag to look around, scroll or pinch to zoom.
export class PanoViewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.style.touchAction = "none";
    container.append(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    const geometry = new THREE.SphereGeometry(10, 128, 64);
    geometry.scale(-1, 1, 1); // look at the sphere from the inside
    this.material = new THREE.MeshBasicMaterial({ color: 0x444444 });
    this.scene.add(new THREE.Mesh(geometry, this.material));
    this.texture = null;

    this.lon = 0; // degrees right of the image center
    this.lat = 0; // degrees above the horizon
    this.pointers = new Map();
    this.pending = false;
    this.gyro = false; // look around by moving the phone
    this.gyroRef = null; // phone yaw that corresponds to lon = 0
    this.onOrientation = this.onOrientation.bind(this);

    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // Shows a new image. Call refresh() instead if the same canvas was just redrawn at the same size.
  setSource(source) {
    this.texture?.dispose();
    this.texture = new THREE.CanvasTexture(source);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.material.map = this.texture;
    this.material.color.set(0xffffff);
    this.material.needsUpdate = true;
    this.requestRender();
  }

  refresh() {
    if (this.texture) this.texture.needsUpdate = true;
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

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    this.lat = Math.max(-89, Math.min(89, this.lat));
    const lat = this.lat * DEG;
    const lon = this.lon * DEG;
    // With three.js's sphere mapping (mirrored to view from inside), the image center faces −X
    // and the right half of the image wraps toward −Z.
    this.camera.lookAt(-Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));
    this.renderer.render(this.scene, this.camera);
  }

  // Turns "move the phone to look around" on or off. On iOS, turning it on must happen in a tap.
  async setGyro(on) {
    if (on && typeof DeviceOrientationEvent?.requestPermission === "function") {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== "granted") throw new Error("Motion access was not allowed.");
    }
    this.gyro = on;
    this.gyroRef = null;
    if (on) window.addEventListener("deviceorientation", this.onOrientation);
    else window.removeEventListener("deviceorientation", this.onOrientation);
  }

  onOrientation(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    const { yaw, pitch } = yawPitchFromDirection(cameraDirection(fromDeviceOrientation(e.alpha, e.beta, e.gamma)));
    // Keep looking where we were when the mode was switched on.
    this.gyroRef ??= yaw - this.lon;
    this.lon = yaw - this.gyroRef;
    this.lat = pitch;
    this.requestRender();
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
        // The scene follows the finger. While moving the phone steers, dragging just turns sideways.
        const degPerPx = this.camera.fov / c.clientHeight;
        if (this.gyro && this.gyroRef != null) {
          this.gyroRef += (e.clientX - prev.x) * degPerPx;
        } else {
          this.lon -= (e.clientX - prev.x) * degPerPx;
          this.lat += (e.clientY - prev.y) * degPerPx;
        }
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
  }

  pinchDistance() {
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}
