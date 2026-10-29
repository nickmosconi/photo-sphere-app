// Saves capture sessions, their photos and finished spheres in the browser's IndexedDB,
// so nothing is lost if Safari reloads the page.

const DB_NAME = "sphere-cam";
const DB_VERSION = 2; // 1: sessions + shots; 2: spheres

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore("sessions", { keyPath: "id" });
        const shots = db.createObjectStore("shots", { keyPath: "id", autoIncrement: true });
        shots.createIndex("sessionId", "sessionId");
      }
      if (e.oldVersion < 2) db.createObjectStore("spheres", { keyPath: "id" });
    };
    req.onsuccess = () => {
      // Let a newer version of the app (in another tab) upgrade the database.
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Runs fn inside a transaction and resolves with the result of the request fn returns,
// only once the transaction has been written to disk.
async function run(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const req = fn(tx);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function putSession(session) {
  return run("sessions", "readwrite", (tx) => tx.objectStore("sessions").put(session));
}

export function getSession(id) {
  return run("sessions", "readonly", (tx) => tx.objectStore("sessions").get(id));
}

export async function listSessions() {
  const sessions = await run("sessions", "readonly", (tx) => tx.objectStore("sessions").getAll());
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteSession(id) {
  return run(["sessions", "shots"], "readwrite", (tx) => {
    tx.objectStore("sessions").delete(id);
    const keys = tx.objectStore("shots").index("sessionId").getAllKeys(id);
    keys.onsuccess = () => keys.result.forEach((key) => tx.objectStore("shots").delete(key));
  });
}

// Returns the new shot's id.
export function addShot(shot) {
  return run("shots", "readwrite", (tx) => tx.objectStore("shots").add(shot));
}

export function deleteShot(id) {
  return run("shots", "readwrite", (tx) => tx.objectStore("shots").delete(id));
}

// All photos of a session, oldest first, including the JPEG blobs.
export async function getShots(sessionId) {
  const shots = await run("shots", "readonly", (tx) =>
    tx.objectStore("shots").index("sessionId").getAll(sessionId),
  );
  return shots.sort((a, b) => a.timestamp - b.timestamp);
}

// Finished spheres: { id, sessionId, createdAt, capturedAt, width, height, headingDeg, stitchSeconds,
// settings, image (JPEG blob with 360° metadata), thumb (small JPEG blob) }.
export function putSphere(sphere) {
  return run("spheres", "readwrite", (tx) => tx.objectStore("spheres").put(sphere));
}

export function getSphere(id) {
  return run("spheres", "readonly", (tx) => tx.objectStore("spheres").get(id));
}

export async function listSpheres() {
  const spheres = await run("spheres", "readonly", (tx) => tx.objectStore("spheres").getAll());
  return spheres.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteSphere(id) {
  return run("spheres", "readwrite", (tx) => tx.objectStore("spheres").delete(id));
}

// Asks the browser not to clear our storage when the phone is low on space (best effort).
export function requestPersistentStorage() {
  navigator.storage?.persist?.().catch(() => {});
}
