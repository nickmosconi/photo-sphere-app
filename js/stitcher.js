import { axisAngle, multiply, toMatrix3 } from "./quat.js?v=0.6.0";
import { photoOrientation } from "./stitch-settings.js?v=0.6.0";

// Stitcher v1 (orientation-based). Makes an equirectangular panorama with WebGL 2:
// for every output pixel, work out its viewing direction, turn it into each photo's camera frame
// using that photo's quaternion, and sample the photo if the direction falls inside it.
// Photos are added one pass at a time into a float buffer (color × weight, weight), then divided
// out, which avoids the limit on how many textures one shader can read on iPhones.
// The result is drawn on a hidden WebGL canvas and copied into a 2D canvas. Browsers cap the size
// of a WebGL canvas (8192 × 4096 fails in Chrome), so bigger results are drawn into a texture
// and read back pixel by pixel instead, which is slower.

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  // One triangle that covers the whole screen.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
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
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uFlip) p.y = textureSize(uAcc, 0).y - 1 - p.y;
  vec4 a = texelFetch(uAcc, p, 0);
  outColor = a.a > 0.0 ? vec4(a.rgb / a.a, 1.0) : vec4(0.5, 0.5, 0.5, 1.0); // gray where nothing was captured
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
    this.out = null; // final 8-bit image, only for outputs too big for the canvas
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
  //             feather, sharpness, matchExposure, vignette, useAligned, refine, tint, yaw0Deg }
  stitch(settings, target) {
    this.#begin(settings);
    this.photos.forEach((photo, i) => this.#drawPhoto(photo, i, this.photos.length, settings));
    this.#finish(target);
  }

  // Same result, but with only one photo on the GPU at a time, to save memory on phones.
  // loadPhoto(i) resolves to { image, quaternion, quaternionAligned?, quaternionRefined?, gain? }; each image is freed
  // (see freeImage) once it has been copied to the GPU.
  async stitchOneByOne(settings, target, count, loadPhoto, freeImage) {
    this.#begin(settings);
    for (let i = 0; i < count; i++) {
      const p = await loadPhoto(i);
      const photo = this.#upload(p);
      freeImage?.(p.image);
      this.#drawPhoto(photo, i, count, settings);
      this.gl.deleteTexture(photo.texture);
    }
    this.#finish(target);
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

  #begin(settings) {
    const gl = this.gl;
    this.#ensureSize(settings.outputWidth, settings.outputWidth / 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accFbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Adds one photo's color × weight and weight into the float buffer.
  #drawPhoto(photo, i, count, settings) {
    const gl = this.gl;
    // Small fixed turn of the camera relative to the phone, the same for every photo.
    const offset = multiply(
      multiply(axisAngle([0, 1, 0], settings.yawOffsetDeg), axisAngle([1, 0, 0], settings.pitchOffsetDeg)),
      axisAngle([0, 0, 1], settings.rollOffsetDeg),
    );
    const tanHalf = Math.tan((settings.fovLongDeg * Math.PI) / 360);
    const q = multiply(photoOrientation(photo, settings), offset);

    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const p = this.photoProgram;
    gl.useProgram(p.program);
    gl.uniform1i(p.uniforms.uPhoto, 0);
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

  // Divides out the weights and copies the result into the target canvas.
  #finish(target) {
    const gl = this.gl;
    const { width, height } = this;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    const n = this.normalizeProgram;
    gl.useProgram(n.program);
    gl.uniform1i(n.uniforms.uAcc, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.acc);
    if (target.width !== width || target.height !== height) {
      target.width = width;
      target.height = height;
    }
    const ctx = target.getContext("2d");
    if (!ctx) throw new Error(`This device can't hold a ${width}×${height} image.`);

    if (this.canvasFits) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.uniform1i(n.uniforms.uFlip, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.#checkErrors();
      ctx.drawImage(this.canvas, 0, 0);
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFbo);
    gl.uniform1i(n.uniforms.uFlip, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels.data);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.#checkErrors();
    ctx.putImageData(this.pixels, 0, 0);
  }

  // Fails loudly instead of handing back a blank image (phones can run out of graphics memory).
  #checkErrors() {
    const gl = this.gl;
    if (gl.isContextLost()) throw new Error("The graphics memory ran out while stitching.");
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Stitching failed (WebGL error ${error}).`);
  }

  #ensureSize(width, height) {
    if (this.width === width && this.height === height) return;
    const gl = this.gl;
    const maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0];
    if (width > Math.min(maxTexture, maxViewport)) {
      throw new Error(`This device can't make a ${width}×${height} image. Try a smaller output size.`);
    }
    this.#freeBuffers();
    [this.acc, this.accFbo] = renderTarget(gl, gl.RGBA16F, width, height);
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvasFits = gl.drawingBufferWidth === width && gl.drawingBufferHeight === height;
    if (!this.canvasFits) {
      this.canvas.width = this.canvas.height = 1; // free it; not used
      // Made here, not while drawing: creating a texture changes what's bound, and binding it
      // where the float buffer was would make the final pass read from what it draws into.
      [this.out, this.outFbo] = renderTarget(gl, gl.RGBA8, width, height);
      this.pixels = new ImageData(width, height);
    }
    this.width = width;
    this.height = height;
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
