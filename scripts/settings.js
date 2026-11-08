import { MODULE_ID, TRANSITIONS, loc } from "./constants.js";

export function registerSettings() {
  const isForge = typeof ForgeVTT !== "undefined" && ForgeVTT?.usingTheForge;

  // ---------------- World (GM) ----------------
  game.settings.register(MODULE_ID, "uploadSource", {
    name: "CHANGELING.Settings.UploadSource.Name",
    hint: "CHANGELING.Settings.UploadSource.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      data: "CHANGELING.Settings.UploadSource.Data",
      forgevtt: "CHANGELING.Settings.UploadSource.Forge",
      s3: "CHANGELING.Settings.UploadSource.S3"
    },
    default: isForge ? "forgevtt" : "data"
  });

  game.settings.register(MODULE_ID, "uploadBucket", {
    name: "CHANGELING.Settings.UploadBucket.Name",
    hint: "CHANGELING.Settings.UploadBucket.Hint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "uploadPath", {
    name: "CHANGELING.Settings.UploadPath.Name",
    hint: "CHANGELING.Settings.UploadPath.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "changeling-faces"
  });

  game.settings.register(MODULE_ID, "uploadMode", {
    name: "CHANGELING.Settings.UploadMode.Name",
    hint: "CHANGELING.Settings.UploadMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      auto: "CHANGELING.Settings.UploadMode.Auto",
      gm: "CHANGELING.Settings.UploadMode.GM"
    },
    default: isForge ? "gm" : "auto"
  });

  game.settings.register(MODULE_ID, "maxImageSize", {
    name: "CHANGELING.Settings.MaxImageSize.Name",
    hint: "CHANGELING.Settings.MaxImageSize.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 256, max: 4096, step: 128 },
    default: 1024
  });

  game.settings.register(MODULE_ID, "revertOnDeath", {
    name: "CHANGELING.Settings.RevertOnDeath.Name",
    hint: "CHANGELING.Settings.RevertOnDeath.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "whisperGM", {
    name: "CHANGELING.Settings.WhisperGM.Name",
    hint: "CHANGELING.Settings.WhisperGM.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "allCharacters", {
    name: "CHANGELING.Settings.AllCharacters.Name",
    hint: "CHANGELING.Settings.AllCharacters.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // ---------------- Client (each player) ----------------
  game.settings.register(MODULE_ID, "changeName", {
    name: "CHANGELING.Settings.ChangeName.Name",
    hint: "CHANGELING.Settings.ChangeName.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "updatePrototype", {
    name: "CHANGELING.Settings.UpdatePrototype.Name",
    hint: "CHANGELING.Settings.UpdatePrototype.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "changePortrait", {
    name: "CHANGELING.Settings.ChangePortrait.Name",
    hint: "CHANGELING.Settings.ChangePortrait.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "transition", {
    name: "CHANGELING.Settings.Transition.Name",
    hint: "CHANGELING.Settings.Transition.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: Object.fromEntries(TRANSITIONS.map(t => [t, `CHANGELING.Transitions.${t}`])),
    default: "morph"
  });

  game.settings.register(MODULE_ID, "transitionDuration", {
    name: "CHANGELING.Settings.TransitionDuration.Name",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 200, max: 3000, step: 100 },
    default: 900
  });

  game.settings.register(MODULE_ID, "promptName", {
    name: "CHANGELING.Settings.PromptName.Name",
    hint: "CHANGELING.Settings.PromptName.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "syncTVA", {
    name: "CHANGELING.Settings.SyncTVA.Name",
    hint: "CHANGELING.Settings.SyncTVA.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
}

export function registerKeybindings(handlers) {
  const kb = (id, key, onDown) => game.keybindings.register(MODULE_ID, id, {
    name: `CHANGELING.Keys.${id}.Name`,
    hint: `CHANGELING.Keys.${id}.Hint`,
    editable: [{ key, modifiers: ["Alt"] }],
    restricted: false,
    onDown: () => { onDown(); return true; }
  });
  kb("capture", "KeyC", handlers.capture);
  kb("library", "KeyV", handlers.library);
  kb("revert", "KeyR", handlers.revert);
  kb("captureMode", "KeyX", handlers.captureMode);
}

export { loc };
