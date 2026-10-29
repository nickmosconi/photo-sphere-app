// Decodes a JPEG blob, scaled down so its long side is at most maxSize.
export async function decodeImage(blob, maxSize) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  if (scale === 1) return bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

// Releases a decoded image's memory right away instead of waiting for the garbage collector.
export function freeImage(image) {
  if (image.close) image.close();
  else image.width = image.height = 0;
}

export function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the JPEG."))), "image/jpeg", quality),
  );
}
