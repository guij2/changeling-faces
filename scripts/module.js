import { MODULE_ID, TRUE_FORM_ID, PALETTE } from "./constants.js";
import { registerSettings, registerKeybindings } from "./settings.js";
import {
  resolveChangeling, getAppearances, getTrueForm, getCurrentId, addAppearance, removeAppearance, canUseOn,
  hasAnyChangeling, isChangelingActor, setChangeling, looksLikeChangeling
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
    /** GM only: designate/undesignate an actor as a changeling. */
    setChangeling,
    isChangelingActor,
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
  const visible = !!game.actors && hasAnyChangeling();
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

/* GM changed who is a changeling: redraw everything that depends on it, on every client. */
Hooks.on(`${MODULE_ID}.designation`, () => {
  if (state.captureMode && !resolveChangeling()) setCaptureMode(false);
  // Core drops invisible tools when preparing controls, so they must be rebuilt, not just re-rendered.
  ui.controls?.render({ reset: true });
  const hud = canvas?.tokens?.hud;
  if (hud?.rendered) {
    // Collapse our palette first: core re-activates the remembered palette after rendering and would fail
    // if our palette no longer exists (actor undesignated).
    if (hud.activePalette === PALETTE) hud.togglePalette(PALETTE, false);
    hud.render();
  }
  refreshLibraries();
});

/* GM: right-click an actor in the sidebar to designate / undesignate it as a changeling. */
Hooks.on("getActorContextOptions", (app, entries) => {
  if (!game.user.isGM) return;
  const actorFrom = li => game.actors.get((li?.dataset ?? li?.[0]?.dataset)?.entryId);
  const v14 = (game.release?.generation ?? 13) >= 14;
  const entry = (labelKey, icon, isVisible, run) => v14
    ? { label: labelKey, icon, visible: li => isVisible(actorFrom(li)), onClick: (event, li) => run(actorFrom(li)) }
    : { name: labelKey, icon, condition: li => isVisible(actorFrom(li)), callback: li => run(actorFrom(li)) };
  entries.push(
    entry("CHANGELING.GM.Designate", `<i class="fa-solid fa-masks-theater"></i>`,
      a => !!a && !isChangelingActor(a), a => setChangeling(a, true)),
    entry("CHANGELING.GM.Undesignate", `<i class="fa-solid fa-user-slash"></i>`,
      a => !!a && isChangelingActor(a), a => setChangeling(a, false))
  );
});
