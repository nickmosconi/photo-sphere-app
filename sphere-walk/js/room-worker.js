import { renderRoom } from "./room.js?v=0.3.0";

// Draws the test room off the main thread, so the page stays responsive meanwhile.
self.onmessage = (e) => {
  const room = renderRoom(e.data);
  self.postMessage(room, [room.color.buffer, room.depth.buffer]);
};
