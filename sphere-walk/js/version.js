// Sphere Walk has its own version number, separate from Sphere Cam's.
// Bump it on every deploy, and replace the old "?v=" number in every file in sphere-walk/
// (imports of Sphere Cam's ../js/ files keep Sphere Cam's number).
export const VERSION = "v0.3.0";

// Adds a small version badge to the corner of the page (styled by Sphere Cam's stylesheet).
export function showVersion() {
  const badge = document.createElement("div");
  badge.className = "version-badge";
  badge.textContent = `Sphere Walk ${VERSION}`;
  document.body.appendChild(badge);
}
