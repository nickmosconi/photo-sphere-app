// JSZip from a CDN, loaded only when it's needed.
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

export async function loadJSZip() {
  return (await import(JSZIP_URL)).default;
}
