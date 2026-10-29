// Bump this on every deploy so the phone can show whether it has the latest copy.
// Also replace the old "?v=" number in every .html and .js file: links between pages carry it
// too, because GitHub Pages lets Safari reuse a saved page for 10 minutes.
export const VERSION = "v0.4.1";

// Adds a small version badge to the bottom-right corner of the page.
export function showVersion() {
  const badge = document.createElement("div");
  badge.className = "version-badge";
  badge.textContent = VERSION;
  document.body.appendChild(badge);
}
