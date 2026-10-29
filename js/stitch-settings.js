// Stitching settings used on the phone, and the Stitch Lab's starting values.
// When better values are found in the Lab, paste its "Copy settings" output here.
// 68° fits the first real iPhone session best (overlap agreement was lowest at 67–68°);
// the offsets showed no clear preference, so they stay at 0. Sharpness 15 with brightness
// matching removed most see-through ghosting without making seams stand out; 25+ showed patches.
export const STITCH_DEFAULTS = {
  fovLongDeg: 68,
  yawOffsetDeg: 0,
  pitchOffsetDeg: 0,
  rollOffsetDeg: 0,
  feather: 0.5,
  sharpness: 15,
  matchExposure: true,
  outputWidth: 4096,
  useAligned: true,
  refine: true, // line photos up using their content (align.js)
  tint: false,
};

// Sizes the phone tries for a finished sphere, largest first. 5792 × 2896 is the biggest image
// iPhone Safari can draw on a canvas (about 16.7 million pixels); it is stitched in 2 strips,
// because in one go it needed about 450 MB and Safari crashed. 4096 (in one go, about 250 MB)
// is the fallback, and what the phone uses after a crash.
export const SPHERE_SIZES = [
  { width: 5792, strips: 2 },
  { width: 4096, strips: 1 },
];

// The phone scales photos to this size (long side) before stitching: 30 pixels per degree,
// more than the 16 a 5792-wide sphere can hold.
export const MAX_PHOTO_SIZE = 2048;

// The orientation to use for a photo: refined by alignment if available and wanted,
// otherwise as recorded (compass-aligned or raw).
export function photoOrientation(photo, settings) {
  if (settings.refine && photo.quaternionRefined) return photo.quaternionRefined;
  return settings.useAligned ? photo.quaternionAligned ?? photo.quaternion : photo.quaternion;
}
