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
  tint: false,
};

// Photos are scaled down to this size (long side) before stitching; plenty for a 4096-wide panorama.
export const MAX_PHOTO_SIZE = 2048;
