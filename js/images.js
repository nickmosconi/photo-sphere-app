// Decodes a JPEG blob, scaled down so its long side is at most maxSize. If the photo's size is
// known ({ width, height }), the browser is asked to decode straight to the smaller size, which
// avoids holding a full 12-megapixel copy; browsers that ignore that are handled below.
export async function decodeImage(blob, maxSize, known) {
  let bitmap = null;
  if (known?.width && known?.height) {
    const s = Math.min(1, maxSize / Math.max(known.width, known.height));
    try {
      bitmap = await createImageBitmap(blob, {
        resizeWidth: Math.round(known.width * s),
        resizeHeight: Math.round(known.height * s),
        resizeQuality: "high",
      });
    } catch {
      bitmap = null;
    }
  }
  bitmap ??= await createImageBitmap(blob);
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
