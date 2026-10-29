// Small quaternion and direction helpers. Quaternions are [x, y, z, w].
//
// World frame: Z points straight up, X and Y are horizontal (W3C DeviceOrientation "earth" frame;
// on iOS the zero of alpha is arbitrary, so horizontal directions are only relative).
// Device frame (portrait): X to the right of the screen, Y toward the top of the phone,
// Z out of the screen toward the user. The rear camera looks along the device's -Z axis.

const DEG = Math.PI / 180;

export function multiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function conjugate([x, y, z, w]) {
  return [-x, -y, -z, w];
}

export function axisAngle([ax, ay, az], deg) {
  const half = (deg * DEG) / 2;
  const s = Math.sin(half);
  return [ax * s, ay * s, az * s, Math.cos(half)];
}

// Rotation that takes device-frame vectors into the world frame.
// W3C order: alpha about Z, then beta about the new X, then gamma about the new Y.
export function fromDeviceOrientation(alpha, beta, gamma) {
  return multiply(
    multiply(axisAngle([0, 0, 1], alpha), axisAngle([1, 0, 0], beta)),
    axisAngle([0, 1, 0], gamma),
  );
}

// Applies rotation q to vector v.
export function rotate(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

// 3×3 rotation matrix of q, row by row (world = M · device).
export function toMatrix3([x, y, z, w]) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}

// World direction the rear camera is looking.
export function cameraDirection(q) {
  return rotate(q, [0, 0, -1]);
}

// Yaw is measured clockwise from +Y seen from above (like a compass heading); pitch is up from the horizon.
export function directionFromYawPitch(yawDeg, pitchDeg) {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  return [Math.sin(yaw) * Math.cos(pitch), Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch)];
}

export function yawPitchFromDirection([x, y, z]) {
  return {
    yaw: Math.atan2(x, y) / DEG,
    pitch: Math.asin(Math.min(1, Math.max(-1, z))) / DEG,
  };
}

// Angle in degrees between two unit vectors.
export function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, dot))) / DEG;
}

// Wraps an angle into the range -180..180.
export function wrapDeg(deg) {
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

// Average of angles that handles the 359° → 0° wrap-around.
export class CircularMean {
  constructor() {
    this.sin = 0;
    this.cos = 0;
    this.count = 0;
  }

  add(deg) {
    this.sin += Math.sin(deg * DEG);
    this.cos += Math.cos(deg * DEG);
    this.count++;
  }

  mean() {
    return Math.atan2(this.sin, this.cos) / DEG;
  }
}
