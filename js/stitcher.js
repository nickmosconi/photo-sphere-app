import { axisAngle, multiply, toMatrix3 } from "./quat.js?v=0.7.0";
import { photoOrientation } from "./stitch-settings.js?v=0.7.0";

// Stitcher v1 (orientation-based). Makes an equirectangular panorama with WebGL 2:
// for every output pixel, work out its viewing direction, turn it into each photo's camera frame
// using that photo's quaternion, and sample the photo if the direction falls inside it.
// Photos are added one pass at a time into a float buffer (color × weight, weight), then divided
// out, which avoids the limit on how many textures one shader can read on iPhones.
// The result is drawn on a hidden WebGL canvas and copied into a 2D canvas. Browsers cap the size
// of a WebGL canvas (8192 × 4096 fails in Chrome), so bigger results are drawn into a texture
// and read back pixel by pixel instead, which is slower.
// On phones a big sphere can be made in horizontal strips: the buffers then only need to be one
// strip tall, which divides the biggest memory cost by the number of strips.

const VERT = `#version 300 es
uniform vec2 uUvOffset; // which part of the panorama this pass covers (a strip, or all of it)
uniform vec2 uUvScale;
out vec2 vUv;
void main() {
  // One triangle that covers the whole screen.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = uUvOffset + p * uUvScale;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const PHOTO_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPhoto;
uniform mat3 uWorldToCam;
uniform vec2 uSize;     // photo size in pixels
uniform float uFocal;   // photo focal length in pixels
uniform float uYaw0;    // yaw at the center of the panorama (radians)
uniform float uFeather; // 0..1: how far in from the photo edge the weight ramps up
uniform float uSharpness; // 0 = average overlapping photos; higher = favor the photo whose center is nearest
uniform vec3 uGain;     // brightness/color correction for this photo
uniform vec3 uVignette; // how much to brighten toward the corners (lens vignetting)
uniform vec4 uTint;     // rgb + amount, to show which photo is where
out vec4 outColor;
const float PI = 3.14159265358979;
void main() {
  float yaw = uYaw0 + (vUv.x - 0.5) * 2.0 * PI;
  float pitch = (vUv.y - 0.5) * PI;
  vec3 dir = vec3(sin(yaw) * cos(pitch), cos(yaw) * cos(pitch), sin(pitch));
  vec3 v = uWorldToCam * dir;
  if (v.z > -1e-4) discard; // behind the camera
  vec2 uv = (v.xy / -v.z) * uFocal / uSize + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
  vec2 e = min(uv, 1.0 - uv) * 2.0; // 0 at the edge, 1 at the center
  float edgeFade = smoothstep(0.0, uFeather, e.x) * smoothstep(0.0, uFeather, e.y);
  // Angle from the photo's center, in units of half its narrow field of view. Weighting by
  // exp(−sharpness × angle) lets the nearest photo win, so small misalignments show up as
  // a slight step at a seam instead of a see-through double image.
  float angle = acos(clamp(-v.z / length(v), -1.0, 1.0)) / atan(0.5 * min(uSize.x, uSize.y) / uFocal);
  float w = max(edgeFade * exp(-uSharpness * angle), 1e-6);
  vec3 c = texture(uPhoto, vec2(uv.x, 1.0 - uv.y)).rgb; // image rows run top to bottom
  float r2 = dot(uv - 0.5, uv - 0.5) * 2.0; // 0 at the center, 1 in the corners
  c *= uGain * exp(uVignette * r2);
  c = mix(c, uTint.rgb, uTint.a);
  outColor = vec4(c * w, w);
}`;

const NORMALIZE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uAcc;
uniform bool uFlip; // when reading pixels back, so rows come out top to bottom like an image
uniform float uSharpen; // 0 = off; how much of the difference from a 3×3 blur to add back
out vec4 outColor;
vec3 colorAt(ivec2 p) {
  p = clamp(p, ivec2(0), textureSize(uAcc, 0) - 1);
  vec4 a = texelFetch(uAcc, p, 0);
  return a.a > 0.0 ? a.rgb / a.a : vec3(0.5);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uFlip) p.y = textureSize(uAcc, 0).y - 1 - p.y;
  vec4 a = texelFetch(uAcc, p, 0);
  if (a.a <= 0.0) {
    outColor = vec4(0.5, 0.5, 0.5, 1.0); // gray where nothing was captured
    return;
  }
  vec3 c = a.rgb / a.a;
  if (uSharpen > 0.0) {
    vec3 blur = vec3(0.0);
    for (int dy = -1; dy <= 1; dy++) {
      for (int dx = -1; dx <= 1; dx++) blur += colorAt(p + ivec2(dx, dy));
    }
    c += uSharpen * (c - blur / 9.0);
  }
  outColor = vec4(c, 1.0);
}`;

export class Stitcher {
  constructor() {
    this.canvas = document.createElement("canvas");
    // preserveDrawingBuffer keeps the result readable after the frame ends.
    const gl = this.canvas.getContext("webgl2", { preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error("This browser doesn't support WebGL 2.");
    if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) {
      throw new Error("This browser can't render to float textures.");
    }
    this.gl = gl;
    this.photoProgram = program(gl, VERT, PHOTO_FRAG);
    this.normalizeProgram = program(gl, VERT, NORMALIZE_FRAG);
    this.vao = gl.createVertexArray();
    this.photos = [];
    this.width = 0;
    this.height = 0;
    this.canvasFits = false; // whether the hidden canvas can be the full output size
    this.acc = null; // float buffer the photos are added into
    this.accFbo = null;
    this.out = null; // final 8-bit image, for read-back (outputs too big for the canvas, or strips)
    this.outFbo = null;
    this.pixels = null;
  }

  // photos: [{ image, quaternion, quaternionAligned?, quaternionRefined?, gain? }]. Images are copied to the GPU,
  // so the caller can free them afterwards.
  setPhotos(photos) {
    this.photos.forEach((p) => this.gl.deleteTexture(p.texture));
    this.photos = photos.map((p) => this.#upload(p));
  }

  // Stitches the photos given to setPhotos and draws the panorama into `target`
  // (a 2D canvas, resized to fit). Fast enough to re-run on every slider move.
  // settings: { outputWidth, fovLongDeg, yawOffsetDeg, pitchOffsetDeg, rollOffsetDeg,
  //             feather, sharpness, sharpen, matchExposure, vignette, useAligned, refine, tint, yaw0Deg }
  stitch(settings, target) {
    this.readBack = false;
    this.#begin(settings, 0, 1);
    this.photos.forEach((photo, i) => this.#drawPhoto(photo, i, this.photos.length, settings));
    this.#finish(target, 0);
  }

  // Same result, but with only one photo on the GPU at a time and the panorama made in `strips`
  // horizontal strips, to save memory on phones. photos: [{ quaternion, quaternionAligned?,
  // quaternionRefined?, gain?, width?, height? }] without images; loadImage(i, strip) resolves to
  // photo i's image, which is freed (see freeImage) once it is on the GPU. Photos that can't reach
  // a strip are skipped for it.
  // target is a 2D canvas (the whole panorama is drawn into it), or a function
  // onStrip(rgba, width, rows, y) that receives each finished strip's pixels, top to bottom,
  // so even a panorama bigger than any canvas can be saved piece by piece.
  async stitchOneByOne(settings, target, photos, loadImage, freeImage, strips = 1) {
    this.readBack = typeof target === "function";
    const ranges = photos.map((meta) => pitchRange(meta, settings));
    for (let strip = 0; strip < strips; strip++) {
      this.#begin(settings, strip, strips);
      // Pitch range of this strip (strip 0 is at the top).
      const top = 90 - (180 * strip) / strips;
      const bottom = 90 - (180 * (strip + 1)) / strips;
      for (const [i, meta] of photos.entries()) {
        if (ranges[i].min >= top || ranges[i].max <= bottom) continue;
        const image = await loadImage(i, strip);
        const photo = this.#upload({ ...meta, image });
        freeImage?.(image);
        this.#drawPhoto(photo, i, photos.length, settings);
        this.gl.deleteTexture(photo.texture);
      }
      this.#finish(target, (strip * this.fullHeight) / strips);
    }
  }

  #upload(p) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, p.image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return {
      texture,
      width: p.image.width,
      height: p.image.height,
      quaternion: p.quaternion,
      quaternionAligned: p.quaternionAligned,
      quaternionRefined: p.quaternionRefined,
      gain: p.gain ?? [1, 1, 1],
    };
  }

  // Starts a pass over one strip (of `strips`) of the panorama.
  #begin(settings, strip, strips) {
    const gl = this.gl;
    this.fullWidth = settings.outputWidth;
    this.fullHeight = settings.outputWidth / 2;
    this.#ensureSize(this.fullWidth, this.fullHeight / strips, this.readBack);
    // vUv.y runs from 0 at the bottom to 1 at the top; strip 0 is the top one.
    this.uvOffset = [0, (strips - 1 - strip) / strips];
    this.uvScale = [1, 1 / strips];
    this.sharpen = settings.sharpen ?? 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accFbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Adds one photo's color × weight and weight into the float buffer.
  #drawPhoto(photo, i, count, settings) {
    const gl = this.gl;
    const tanHalf = Math.tan((settings.fovLongDeg * Math.PI) / 360);
    const q = multiply(photoOrientation(photo, settings), cameraOffset(settings));

    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const p = this.photoProgram;
    gl.useProgram(p.program);
    gl.uniform1i(p.uniforms.uPhoto, 0);
    gl.uniform2fv(p.uniforms.uUvOffset, this.uvOffset);
    gl.uniform2fv(p.uniforms.uUvScale, this.uvScale);
    gl.uniform1f(p.uniforms.uYaw0, ((settings.yaw0Deg ?? 0) * Math.PI) / 180);
    gl.uniform1f(p.uniforms.uFeather, settings.feather);
    gl.uniform1f(p.uniforms.uSharpness, settings.sharpness ?? 0);
    gl.uniform3fv(p.uniforms.uGain, settings.matchExposure ? photo.gain : [1, 1, 1]);
    gl.uniform3fv(p.uniforms.uVignette, (settings.matchExposure && settings.vignette) || [0, 0, 0]);
    // The row-major camera→world matrix, read as column-major, is its transpose: world→camera.
    gl.uniformMatrix3fv(p.uniforms.uWorldToCam, false, toMatrix3(q));
    gl.uniform2f(p.uniforms.uSize, photo.width, photo.height);
    gl.uniform1f(p.uniforms.uFocal, Math.max(photo.width, photo.height) / 2 / tanHalf);
    const [r, g, b] = settings.tint ? tintColor(i, count) : [0, 0, 0];
    gl.uniform4f(p.uniforms.uTint, r, g, b, settings.tint ? 0.35 : 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, photo.texture);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Divides out the weights and copies the result (the whole panorama, or one strip of it,
  // placed at row y) into the target canvas.
  #finish(target, y) {
    const gl = this.gl;
    const { width, height } = this;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    const n = this.normalizeProgram;
    gl.useProgram(n.program);
    gl.uniform1i(n.uniforms.uAcc, 0);
    gl.uniform1f(n.uniforms.uSharpen, this.sharpen);
    gl.bindTexture(gl.TEXTURE_2D, this.acc);

    if (typeof target === "function") {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFbo);
      gl.uniform1i(n.uniforms.uFlip, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels.data);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.#checkErrors();
      target(this.pixels.data, width, height, y);
      return;
    }

    if (target.width !== this.fullWidth || target.height !== this.fullHeight) {
      target.width = this.fullWidth;
      target.height = this.fullHeight;
    }
    const ctx = target.getContext("2d");
    if (!ctx) throw new Error(`This device can't hold a ${this.fullWidth}×${this.fullHeight} image.`);

    if (this.canvasFits) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.uniform1i(n.uniforms.uFlip, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.#checkErrors();
      ctx.drawImage(this.canvas, 0, y);
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFbo);
    gl.uniform1i(n.uniforms.uFlip, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels.data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#checkErrors();
    ctx.putImageData(this.pixels, 0, y);
  }

  // Fails loudly instead of handing back a blank image (phones can run out of graphics memory).
  #checkErrors() {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error("The graphics memory ran out while stitching.");
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Stitching failed (WebGL error ${error}).`);
  }

  // Makes the buffers for a width × height pass. With readBack, results are always read back as
  // pixels, so the hidden canvas isn't needed at that size.
  #ensureSize(width, height, readBack = false) {
    if (this.width === width && this.height === height && this.readBackSized === readBack) return;
    const gl = this.gl;
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0];
    if (width > Math.min(maxTexture, maxViewport)) {
      throw new Error(`This device can't make a ${width}×${height} image. Try a smaller output size.`);
    }
    this.#freeBuffers();
    [this.acc, this.accFbo] = renderTarget(gl, gl.RGBA16F, width, height);
    if (readBack) {
      this.canvasFits = false;
    } else {
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvasFits = gl.drawingBufferWidth === width && gl.drawingBufferHeight === height;
    }
    if (!this.canvasFits) {
      this.canvas.width = this.canvas.height = 1; // free it; not used
      // Made here, not while drawing: creating a texture changes what's bound, and binding it
      // where the float buffer was would make the final pass read from what it draws into.
      [this.out, this.outFbo] = renderTarget(gl, gl.RGBA8, width, height);
      this.pixels = new ImageData(width, height);
    }
    this.width = width;
    this.height = height;
    this.readBackSized = readBack;
  }

  #freeBuffers() {
    const gl = this.gl;
    gl.deleteTexture(this.acc);
    gl.deleteFramebuffer(this.accFbo);
    gl.deleteTexture(this.out);
    gl.deleteFramebuffer(this.outFbo);
    this.acc = this.accFbo = this.out = this.outFbo = this.pixels = null;
    this.width = this.height = 0;
  }

  // Frees everything, including the WebGL context (phones only allow a few at once).
  dispose() {
    this.photos.forEach((p) => this.gl.deleteTexture(p.texture));
    this.photos = [];
    this.#freeBuffers();
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// A texture plus a framebuffer for drawing into it.
function renderTarget(gl, format, width, height) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(texture);
    gl.deleteFramebuffer(fbo);
    throw new Error(`Couldn't set up a ${width}×${height} stitching buffer. Try a smaller output size.`);
  }
  return [texture, fbo];
}

// Lowest and highest pitch (degrees) a photo covers: its border traced through its orientation,
// extended to ±90° if it contains straight up or down. Used to skip photos that can't reach a strip.
function pitchRange(meta, settings) {
  const m = toMatrix3(multiply(photoOrientation(meta, settings), cameraOffset(settings)));
  const tanHalf = Math.tan((settings.fovLongDeg * Math.PI) / 360);
  const w = meta.width ?? 3;
  const h = meta.height ?? 4;
  const tx = (tanHalf * w) / Math.max(w, h); // half-width and half-height on the image plane
  const ty = (tanHalf * h) / Math.max(w, h);
  let min = 90;
  let max = -90;
  const add = (x, y) => {
    // The camera looks along −Z, so a point (x, y) on its image plane is the ray (x, y, −1).
    const wx = m[0] * x + m[1] * y - m[2];
    const wy = m[3] * x + m[4] * y - m[5];
    const wz = m[6] * x + m[7] * y - m[8];
    const pitch = (Math.asin(wz / Math.hypot(wx, wy, wz)) * 180) / Math.PI;
    min = Math.min(min, pitch);
    max = Math.max(max, pitch);
  };
  for (let k = 0; k <= 8; k++) {
    const t = -1 + k / 4;
    add(t * tx, ty);
    add(t * tx, -ty);
    add(tx, t * ty);
    add(-tx, t * ty);
  }
  for (const s of [1, -1]) {
    // Straight up (s = 1) or down, in camera coordinates (the transpose of m).
    const vx = m[6] * s;
    const vy = m[7] * s;
    const vz = m[8] * s;
    if (vz < 0 && Math.abs(vx / -vz) <= tx && Math.abs(vy / -vz) <= ty) {
      if (s > 0) max = 90;
      else min = -90;
    }
  }
  return { min: min - 1, max: max + 1 };
}

// Small fixed turn of the camera relative to the phone, the same for every photo.
function cameraOffset(settings) {
  return multiply(
    multiply(axisAngle([0, 1, 0], settings.yawOffsetDeg), axisAngle([1, 0, 0], settings.pitchOffsetDeg)),
    axisAngle([0, 0, 1], settings.rollOffsetDeg),
  );
}

// A different bright color for each photo.
function tintColor(i, count) {
  const h = (i / count) * 6;
  const x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(h) % 6];
  return [r, g, b];
}

function program(gl, vertSrc, fragSrc) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vertSrc], [gl.FRAGMENT_SHADER, fragSrc]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader error: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(prog, shader);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Shader link error: ${gl.getProgramInfoLog(prog)}`);
  const uniforms = {};
  const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const { name } = gl.getActiveUniform(prog, i);
    uniforms[name] = gl.getUniformLocation(prog, name);
  }
  return { program: prog, uniforms };
}
