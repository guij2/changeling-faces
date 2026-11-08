import { MODULE_ID, FLAGS, TRUE_FORM_ID, loc } from "./constants.js";
import { registerSettings, registerKeybindings } from "./settings.js";
import {
  resolveChangeling, getAppearances, getTrueForm, getCurrentId, addAppearance, removeAppearance, canUseOn
} from "./store.js";
import { applyAppearance, revertToTrueForm, registerDeathHooks } from "./apply.js";
import { registerUploadSocket, prepareImage, uploadForActor } from "./upload.js";
import {
  state, captureToken, captureHovered, setCaptureMode, registerCaptureListeners, revertHotkey, addFromFiles, switchTo
} from "./actions.js";
import { registerHUD, refreshPalette } from "./hud.js";
import { openLibrary, refreshLibraries } from "./library.js";

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings({
    capture: () => captureHovered(),
    library: () => openLibrary(),
    revert: () => revertHotkey(),
    captureMode: () => setCaptureMode(!state.captureMode)
  });
  registerHUD();
  registerDeathHooks();
});

Hooks.once("ready", () => {
  registerUploadSocket();
  registerCaptureListeners();

  game.modules.get(MODULE_ID).api = {
    /** Open the face library for an actor (defaults to your changeling). */
    openLibrary,
    /** Memorize the look of a token (Token or TokenDocument). */
    captureToken,
    /** Switch to a memorized appearance by id, or "__true-form__". */
    applyAppearance: (actor, id, options) => switchTo(actor ?? resolveChangeling()?.actor, id, options?.token),
    revert: actor => revertToTrueForm(actor ?? resolveChangeling()?.actor),
    /** Upload File objects as new faces. */
    addFromFiles: (files, actor) => addFromFiles(actor ?? resolveChangeling()?.actor, files),
    setCaptureMode,
    getAppearances,
    getTrueForm,
    getCurrentId,
    addAppearance,
    removeAppearance,
    prepareImage,
    uploadForActor,
    TRUE_FORM_ID
  };
});

/* Redraw open UIs whenever faces change. */
Hooks.on(`${MODULE_ID}.changed`, actor => {
  refreshPalette(actor);
  refreshLibraries(actor);
});
Hooks.on("updateActor", (actor, changes) => {
  if (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) {
    refreshPalette(actor);
    refreshLibraries(actor);
  }
});

/* Token controls: capture mode toggle + library button. */
Hooks.on("getSceneControlButtons", controls => {
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  const visible = !game.user.isGM || game.actors?.some(a => a.getFlag(MODULE_ID, FLAGS.ENABLED) === true);
  tokens.tools.changelingCapture = {
    name: "changelingCapture",
    order: 90,
    title: "CHANGELING.Controls.Capture",
    icon: "fa-solid fa-eye-dropper",
    toggle: true,
    visible,
    active: state.captureMode,
    onChange: (event, active) => {
      if (active !== state.captureMode) setCaptureMode(active);
    }
  };
  tokens.tools.changelingLibrary = {
    name: "changelingLibrary",
    order: 91,
    title: "CHANGELING.Controls.Library",
    icon: "fa-solid fa-masks-theater",
    button: true,
    visible,
    onChange: () => openLibrary()
  };
});

/* Leaving the token layer turns capture mode off. */
Hooks.on("canvasTearDown", () => state.captureMode && setCaptureMode(false));
