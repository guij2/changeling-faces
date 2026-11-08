import { MODULE_ID, loc, setting, escapeHTML, DialogV2, isVideo } from "./constants.js";
import {
  resolveChangeling, snapshotToken, addAppearance, getAppearances, updateAppearance, removeAppearance,
  hasAnyChangeling, canUseOn
} from "./store.js";
import { applyAppearance, revertToTrueForm } from "./apply.js";
import { prepareImage, uploadForActor, fetchUrlAsFile } from "./upload.js";

/* ------------------------------------------------------------------ */
/*  Shared UI state                                                    */
/* ------------------------------------------------------------------ */

export const state = {
  captureMode: false,
  uploading: 0
};

/** Notify open UIs (HUD palette, library windows) that they should redraw. */
export function emitChange(actor = null) {
  Hooks.callAll(`${MODULE_ID}.changed`, actor);
}

/** Players the GM did not designate get no feedback at all, so the module stays invisible to them. */
function requireChangeling(token = null) {
  const found = resolveChangeling(token);
  if (!found && hasAnyChangeling()) ui.notifications.warn(loc("Notify.NoChangeling"));
  return found;
}

/* ------------------------------------------------------------------ */
/*  Naming                                                             */
/* ------------------------------------------------------------------ */

/** Name of a token as the current user is allowed to see it. */
function visibleName(token) {
  const doc = token.document ?? token;
  const M = CONST.TOKEN_DISPLAY_MODES;
  const owner = doc.isOwner || game.user.isGM;
  const mode = doc.displayName;
  const visible = owner || mode === M.ALWAYS || mode === M.HOVER;
  return visible && doc.name ? doc.name : null;
}

function unknownName(actor) {
  return loc("UnknownFace", { n: getAppearances(actor).length + 1 });
}

/**
 * Ask the user for a name (with a preview of the face).
 * @returns {Promise<string|null>} null when cancelled
 */
export async function promptName({ title, defaultName, src }) {
  if (!setting("promptName")) return defaultName;
  const media = src
    ? (isVideo(src)
      ? `<video src="${escapeHTML(src)}" autoplay muted loop></video>`
      : `<img src="${escapeHTML(src)}" alt="">`)
    : "";
  const content = `
    <div class="cf-name-prompt">
      ${media ? `<div class="cf-name-preview">${media}</div>` : ""}
      <label>${loc("Dialog.NameLabel")}
        <input type="text" name="faceName" value="${escapeHTML(defaultName)}" autofocus>
      </label>
    </div>`;
  try {
    const result = await DialogV2().prompt({
      window: { title, icon: "fa-solid fa-masks-theater" },
      classes: ["changeling-faces-dialog"],
      content,
      ok: {
        label: loc("Dialog.Memorize"),
        icon: "fa-solid fa-brain",
        callback: (event, button) => button.form.elements.faceName.value.trim()
      },
      rejectClose: false,
      render: (event, dialog) => {
        const input = (dialog.element ?? dialog).querySelector?.("input[name=faceName]");
        input?.select();
      }
    });
    if (result === null || result === undefined) return null;
    return result || defaultName;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Capturing other tokens                                             */
/* ------------------------------------------------------------------ */

export async function captureToken(token) {
  const target = token?.document ?? token;
  if (!target) return;
  const found = requireChangeling();
  if (!found) return;
  const { actor } = found;

  if (target.actor && target.actor === actor) {
    ui.notifications.warn(loc("Notify.CannotCopySelf"));
    return;
  }

  const snap = snapshotToken(target);
  if (!snap.texture?.src) return;
  const dupe = getAppearances(actor).find(a => a.texture?.src === snap.texture.src && a.kind === "token");

  const shownName = visibleName(target);
  const name = await promptName({
    title: dupe ? loc("Dialog.CaptureAgainTitle", { name: dupe.name }) : loc("Dialog.CaptureTitle"),
    defaultName: shownName ?? unknownName(actor),
    src: snap.texture.src
  });
  if (name === null) return;

  await addAppearance(actor, {
    name,
    kind: "token",
    texture: snap.texture,
    ring: snap.ring,
    portrait: snap.portrait,
    useName: true
  });
  target.object?.ring?.flashColor?.(foundry.utils.Color.from("#c9a227"), { duration: 600 });
  ui.notifications.info(loc("Notify.Memorized", { name }));
  emitChange(actor);
}

export function captureHovered() {
  if (!hasAnyChangeling()) return;
  const hovered = canvas.tokens?.hover;
  if (!hovered) {
    ui.notifications.warn(loc("Notify.HoverAToken"));
    return;
  }
  return captureToken(hovered);
}

/* ------------------------------------------------------------------ */
/*  Capture mode: click any token on the canvas to memorize it         */
/* ------------------------------------------------------------------ */

export function setCaptureMode(active) {
  active = !!active;
  if (active && !requireChangeling()) active = false;
  state.captureMode = active;
  document.body.classList.toggle("changeling-capture-mode", active);
  const tool = ui.controls?.controls?.tokens?.tools?.changelingCapture;
  if (tool && tool.active !== active) {
    tool.active = active;
    ui.controls.render();
  }
  if (active) ui.notifications.info(loc("Notify.CaptureModeOn"));
  emitChange();
}

export function registerCaptureListeners() {
  // Window capture-phase listener runs before the canvas' own pointer handling, so we can swallow the click.
  window.addEventListener("pointerdown", event => {
    if (!state.captureMode || event.button !== 0) return;
    if (!canvas?.ready || event.target !== canvas.app.view) return;
    const hovered = canvas.tokens?.hover;
    if (!hovered || hovered.actor === resolveChangeling()?.actor) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    captureToken(hovered);
  }, true);

  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && state.captureMode) setCaptureMode(false);
  });

  // Paste images straight into the library while the palette or library window is open.
  document.addEventListener("paste", event => {
    const files = [...(event.clipboardData?.files ?? [])].filter(f => /^image\/|^video\//.test(f.type));
    if (!files.length) return;
    const paletteOpen = document.querySelector("#token-hud .changeling-palette.active");
    const libraryOpen = document.querySelector(".changeling-faces-library");
    if (!paletteOpen && !libraryOpen) return;
    event.preventDefault();
    const actorId = (libraryOpen ?? paletteOpen)?.dataset.actorId;
    const actor = game.actors.get(actorId) ?? resolveChangeling()?.actor;
    if (actor) addFromFiles(actor, files);
  });
}

/* ------------------------------------------------------------------ */
/*  Uploading new faces                                                */
/* ------------------------------------------------------------------ */

export async function addFromFiles(actor, files) {
  if (!canUseOn(actor)) return;
  const list = [...files].filter(f => /^image\/|^video\//.test(f.type) || /\.(webp|png|jpe?g|gif|avif|svg|webm|mp4)$/i.test(f.name));
  if (!list.length) {
    ui.notifications.warn(loc("Notify.BadType"));
    return;
  }
  for (const file of list) {
    const previewUrl = URL.createObjectURL(file);
    const defaultName = file.name && !/^image\.\w+$/i.test(file.name)
      ? file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ")
      : unknownName(actor);
    const name = await promptName({ title: loc("Dialog.UploadTitle"), defaultName, src: previewUrl });
    URL.revokeObjectURL(previewUrl);
    if (name === null) continue;

    state.uploading++;
    emitChange(actor);
    try {
      const prepared = await prepareImage(file, name);
      const path = await uploadForActor(actor, prepared);
      await addAppearance(actor, {
        name,
        kind: "upload",
        texture: { src: path, scaleX: 1, scaleY: 1 },
        ring: null,
        portrait: null,
        useName: true
      });
      ui.notifications.info(loc("Notify.Uploaded", { name }));
    } catch (err) {
      console.error(`${MODULE_ID} | upload failed`, err);
      ui.notifications.error(`${loc("Notify.UploadFailed")} ${err.message ?? ""}`);
    } finally {
      state.uploading--;
      emitChange(actor);
    }
  }
}

export async function addFromUrl(actor, url) {
  url = String(url ?? "").trim();
  if (!url) return;
  try {
    const file = await fetchUrlAsFile(url);
    return addFromFiles(actor, [file]);
  } catch (err) {
    ui.notifications.error(`${err.message}`);
  }
}

/** Open a native file chooser and upload the chosen images. */
export function pickFiles(actor) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*,video/webm,video/mp4";
  input.multiple = true;
  input.addEventListener("change", () => {
    if (input.files?.length) addFromFiles(actor, input.files);
  });
  input.click();
}

/* ------------------------------------------------------------------ */
/*  Edit / delete dialog                                               */
/* ------------------------------------------------------------------ */

export async function editAppearanceDialog(actor, id) {
  if (!canUseOn(actor)) return;
  const entry = getAppearances(actor).find(a => a.id === id);
  if (!entry) return;
  const src = entry.texture?.src ?? "";
  const scale = Math.abs(entry.texture?.scaleX ?? 1);
  const media = isVideo(src) ? `<video src="${escapeHTML(src)}" autoplay muted loop></video>` : `<img src="${escapeHTML(src)}" alt="">`;
  const content = `
    <div class="cf-name-prompt">
      <div class="cf-name-preview">${media}</div>
      <label>${loc("Dialog.NameLabel")}
        <input type="text" name="faceName" value="${escapeHTML(entry.name)}">
      </label>
      <label class="cf-check"><input type="checkbox" name="useName" ${entry.useName !== false ? "checked" : ""}>
        ${loc("Dialog.UseName")}</label>
      <label>${loc("Dialog.Scale")}
        <input type="number" name="scale" value="${scale}" min="0.2" max="3" step="0.05">
      </label>
    </div>`;

  const result = await DialogV2().wait({
    window: { title: loc("Dialog.EditTitle"), icon: "fa-solid fa-pen" },
    classes: ["changeling-faces-dialog"],
    content,
    rejectClose: false,
    buttons: [
      {
        action: "save", label: loc("Dialog.Save"), icon: "fa-solid fa-check", default: true,
        callback: (event, button) => {
          const f = button.form.elements;
          return { action: "save", name: f.faceName.value.trim(), useName: f.useName.checked, scale: Number(f.scale.value) || 1 };
        }
      },
      { action: "delete", label: loc("Dialog.Delete"), icon: "fa-solid fa-trash", callback: () => ({ action: "delete" }) }
    ]
  });
  if (!result) return;

  if (result.action === "delete") {
    const ok = await DialogV2().confirm({
      window: { title: loc("Dialog.DeleteTitle") },
      content: `<p>${loc("Dialog.DeleteConfirm", { name: escapeHTML(entry.name) })}</p>`,
      rejectClose: false
    });
    if (ok) {
      await removeAppearance(actor, id);
      emitChange(actor);
    }
    return;
  }

  const sx = Math.sign(entry.texture?.scaleX || 1) * result.scale;
  const sy = Math.sign(entry.texture?.scaleY || 1) * result.scale;
  await updateAppearance(actor, id, {
    name: result.name || entry.name,
    useName: result.useName,
    texture: { scaleX: sx, scaleY: sy }
  });
  emitChange(actor);
}

/* ------------------------------------------------------------------ */
/*  Switch                                                             */
/* ------------------------------------------------------------------ */

export async function switchTo(actor, id, token = null) {
  if (!canUseOn(actor)) return;
  await applyAppearance(actor, id, { token });
  emitChange(actor);
}

export async function revertHotkey() {
  const found = requireChangeling();
  if (!found) return;
  await revertToTrueForm(found.actor, { token: found.token });
  emitChange(found.actor);
}
