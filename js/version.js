// Bump this on every deploy so the phone can show whether it has the latest copy.
export const VERSION = "v0.1.0";

// Adds a small version badge to the bottom-right corner of the page.
export function showVersion() {
  const badge = document.createElement("div");
  badge.className = "version-badge";
  badge.textContent = VERSION;
  document.body.appendChild(badge);
}
