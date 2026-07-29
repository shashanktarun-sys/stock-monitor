// Pulse service worker — caches the app shell for offline/quick loads.
// Note: service workers only register on secure contexts (https or localhost).
const CACHE = "pulse-v36";
const SHELL = [
  "/",
