export const MODULE_ID = "changeling-faces";
export const SOCKET = `module.${MODULE_ID}`;
export const PALETTE = "changeling";
export const TRUE_FORM_ID = "__true-form__";

export const FLAGS = {
  APPEARANCES: "appearances",
  TRUE_FORM: "trueForm",
  CURRENT: "current",
  ENABLED: "enabled",
  TVA_SYNCED: "tvaSynced"
};

/** Texture transitions available on Token updates (v12+). */
export const TRANSITIONS = [
  "none", "morph", "fade", "dots", "glitch", "hologram", "holeSwirl", "swirl",
  "waterDrop", "crosshatch", "wind", "waves", "whiteNoise", "hole"
];

export const VIDEO_RE = /\.(webm|mp4|m4v|ogv|ogg)(\?.*)?$/i;

/** Localize a key under the CHANGELING namespace. */
export function loc(key, data) {
  const k = `CHANGELING.${key}`;
  return data ? game.i18n.format(k, data) : game.i18n.localize(k);
}

export function setting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function escapeHTML(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[c]);
}

export function isVideo(src) {
  return VIDEO_RE.test(src ?? "");
}

export function FilePickerImpl() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

export function DialogV2() {
  return foundry.applications.api.DialogV2;
}
