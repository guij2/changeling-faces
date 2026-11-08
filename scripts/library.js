import { MODULE_ID, TRUE_FORM_ID, loc, escapeHTML, isVideo } from "./constants.js";
import { getAppearances, getTrueForm, getCurrentId, resolveChangeling, moveAppearance, canUseOn } from "./store.js";
import {
  state, switchTo, pickFiles, setCaptureMode, editAppearanceDialog, addFromFiles, addFromUrl, emitChange
} from "./actions.js";
import { setTrueFormFromToken } from "./apply.js";

const { ApplicationV2 } = foundry.applications.api;

/** One library window per actor. */
const instances = new Map();

export function openLibrary(actor = null) {
  actor ??= resolveChangeling()?.actor;
  if (!actor || !canUseOn(actor)) {
    if (actor || resolveChangeling()) ui.notifications.warn(loc("Notify.NoChangeling"));
    return;
  }
  let app = instances.get(actor.id);
  if (!app) {
    app = new FaceLibrary(actor);
    instances.set(actor.id, app);
  }
  app.render({ force: true });
  return app;
}

export function refreshLibraries(actor = null) {
  for (const app of instances.values()) {
    if (!app.rendered) continue;
    if (!canUseOn(app.actor)) {
      app.close();
      continue;
    }
    if (!actor || app.actor.id === actor.id) app.render();
  }
}

function media(src) {
  const s = escapeHTML(src);
  return isVideo(src) ? `<video src="${s}" muted loop playsinline></video>` : `<img src="${s}" alt="" loading="lazy">`;
}

export class FaceLibrary extends ApplicationV2 {
  constructor(actor, options = {}) {
    super({ id: `${MODULE_ID}-library-${actor.id}`, ...options });
    this.actor = actor;
  }

  static DEFAULT_OPTIONS = {
    classes: ["changeling-faces-library"],
    tag: "section",
    window: { icon: "fa-solid fa-masks-theater", resizable: true },
    position: { width: 760, height: 680 },
    actions: {
      apply: FaceLibrary.#onApply,
      edit: FaceLibrary.#onEdit,
      upload: FaceLibrary.#onUpload,
      capture: FaceLibrary.#onCapture,
      importUrl: FaceLibrary.#onImportUrl,
      setTrueForm: FaceLibrary.#onSetTrueForm
    }
  };

  get title() {
    return loc("Library.Title", { name: this.actor.name });
  }

  async _prepareContext() {
    const actor = this.actor;
    const tf = getTrueForm(actor);
    const current = getCurrentId(actor);
    return {
      actor,
      current,
      trueForm: {
        name: tf?.name ?? actor.prototypeToken?.name ?? actor.name,
        src: tf?.texture?.src ?? actor.prototypeToken?.texture?.src,
        saved: !!tf
      },
      faces: getAppearances(actor),
      currentFace: getAppearances(actor).find(a => a.id === current) ?? null
    };
  }

  async _renderHTML(ctx) {
    const { actor, trueForm, faces, current, currentFace } = ctx;
    const status = currentFace
      ? `<span class="cf-status disguised"><i class="fa-solid fa-masks-theater"></i> ${loc("Library.DisguisedAs", { name: escapeHTML(currentFace.name) })}</span>`
      : `<span class="cf-status"><i class="fa-solid fa-fingerprint"></i> ${loc("Library.InTrueForm")}</span>`;

    const cards = faces.map(a => `
      <figure class="cf-card ${a.id === current ? "active" : ""}" data-id="${a.id}" draggable="true">
        <button type="button" class="cf-card-img" data-action="apply" data-id="${a.id}" data-tooltip="${loc("Library.ApplyHint")}">
          ${media(a.texture?.src)}
          ${a.id === current ? `<i class="cf-check fa-solid fa-check"></i>` : ""}
          <i class="cf-kind fa-solid ${a.kind === "upload" ? "fa-cloud-arrow-up" : "fa-eye"}"
             data-tooltip="${loc(a.kind === "upload" ? "Library.KindUpload" : "Library.KindToken")}"></i>
        </button>
        <figcaption>
          <span class="cf-card-name" title="${escapeHTML(a.name)}">${escapeHTML(a.name)}</span>
          <a class="cf-card-edit" data-action="edit" data-id="${a.id}" data-tooltip="${loc("Library.Edit")}"><i class="fa-solid fa-pen"></i></a>
        </figcaption>
      </figure>`).join("");

    const uploading = Array.from({ length: state.uploading }, () =>
      `<figure class="cf-card cf-uploading"><div class="cf-card-img"><i class="fa-solid fa-spinner fa-spin"></i></div><figcaption>${loc("Uploading")}</figcaption></figure>`
    ).join("");

    return `
      <header class="cf-lib-header">
        <div class="cf-true-card ${current ? "" : "active"}">
          <button type="button" class="cf-card-img" data-action="apply" data-id="${TRUE_FORM_ID}"
                  data-tooltip="${loc("Library.RevertHint")}">
            ${trueForm.src ? media(trueForm.src) : ""}
            <i class="cf-badge fa-solid fa-fingerprint"></i>
          </button>
        </div>
        <div class="cf-lib-info">
          <h2>${escapeHTML(actor.name)}</h2>
          ${status}
          <p class="cf-true-name">${loc("TrueForm")}: <strong>${escapeHTML(trueForm.name)}</strong>
            ${trueForm.saved ? "" : `<em>(${loc("Library.TrueFormAuto")})</em>`}</p>
          <div class="cf-lib-buttons">
            <button type="button" data-action="apply" data-id="${TRUE_FORM_ID}" ${current ? "" : "disabled"}>
              <i class="fa-solid fa-rotate-left"></i> ${loc("Library.Revert")}</button>
            <button type="button" data-action="setTrueForm" data-tooltip="${loc("Library.SetTrueFormHint")}">
              <i class="fa-solid fa-fingerprint"></i> ${loc("Library.SetTrueForm")}</button>
          </div>
        </div>
      </header>

      <section class="cf-dropzone" data-action="upload">
        <i class="fa-solid fa-cloud-arrow-up"></i>
        <div>
          <strong>${loc("Library.DropTitle")}</strong>
          <span>${loc("Library.DropHint")}</span>
        </div>
      </section>

      <div class="cf-lib-row">
        <input type="url" name="url" placeholder="${loc("Library.UrlPlaceholder")}">
        <button type="button" data-action="importUrl"><i class="fa-solid fa-link"></i> ${loc("Library.UrlImport")}</button>
        <button type="button" class="cf-capture ${state.captureMode ? "active" : ""}" data-action="capture">
          <i class="fa-solid fa-eye-dropper"></i> ${loc(state.captureMode ? "Library.CaptureOn" : "Library.Capture")}</button>
      </div>

      <h3 class="cf-section-title">${loc("Library.Known", { n: faces.length })}</h3>
      <div class="cf-grid">
        ${cards}${uploading}
        ${faces.length || state.uploading ? "" : `<p class="cf-empty">${loc("Library.Empty")}</p>`}
      </div>

      <footer class="cf-lib-footer">
        <i class="fa-solid fa-book-open"></i> ${loc("Library.RulesReminder")}
      </footer>`;
  }

  _replaceHTML(result, content) {
    content.innerHTML = result;
    content.closest(".application")?.setAttribute("data-actor-id", this.actor.id);
    content.dataset.actorId = this.actor.id;
  }

  _onRender(context, options) {
    const root = this.element;
    root.dataset.actorId = this.actor.id;
    if (options.isFirstRender) this.#bindWindowListeners(root);

    for (const card of root.querySelectorAll(".cf-card[data-id]")) {
      card.addEventListener("dragstart", ev => ev.dataTransfer.setData(`${MODULE_ID}/face`, card.dataset.id));
      card.addEventListener("contextmenu", ev => {
        ev.preventDefault();
        editAppearanceDialog(this.actor, card.dataset.id);
      });
    }
    root.querySelector("input[name=url]")?.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        addFromUrl(this.actor, ev.target.value);
      }
    });
  }

  /** Listeners on the persistent window element (bound once). */
  #bindWindowListeners(root) {
    const zone = () => root.querySelector(".cf-dropzone");
    root.addEventListener("dragover", ev => {
      const types = ev.dataTransfer?.types ?? [];
      if (types.includes("Files") || types.includes("text/uri-list") || types.includes(`${MODULE_ID}/face`)) {
        ev.preventDefault();
        if (!types.includes(`${MODULE_ID}/face`)) zone()?.classList.add("cf-dragover");
      }
    });
    root.addEventListener("dragleave", ev => {
      if (!root.contains(ev.relatedTarget)) zone()?.classList.remove("cf-dragover");
    });
    root.addEventListener("drop", ev => {
      zone()?.classList.remove("cf-dragover");
      const id = ev.dataTransfer?.getData(`${MODULE_ID}/face`);
      if (id) {
        // Reordering cards
        ev.preventDefault();
        const overCard = ev.target.closest(".cf-card[data-id]");
        if (!overCard || overCard.dataset.id === id) return;
        const to = getAppearances(this.actor).findIndex(a => a.id === overCard.dataset.id);
        return moveAppearance(this.actor, id, to).then(() => emitChange(this.actor));
      }
      const files = ev.dataTransfer?.files;
      if (files?.length) {
        ev.preventDefault();
        return addFromFiles(this.actor, files);
      }
      const url = ev.dataTransfer?.getData("text/uri-list");
      if (url && /^https?:\/\//i.test(url)) {
        ev.preventDefault();
        return addFromUrl(this.actor, url.split(/\r?\n/)[0]);
      }
    });
    root.addEventListener("pointerover", ev => {
      ev.target.closest(".cf-card-img")?.querySelector("video")?.play?.().catch(() => {});
    });
  }

  _onClose(options) {
    super._onClose?.(options);
    instances.delete(this.actor.id);
  }

  /* ---------------- Actions ---------------- */

  static async #onApply(event, target) {
    const id = target.dataset.id;
    if (id !== TRUE_FORM_ID && id === getCurrentId(this.actor)) return;
    if (id === TRUE_FORM_ID && !getCurrentId(this.actor)) return;
    const token = resolveChangeling()?.actor === this.actor ? resolveChangeling().token : null;
    await switchTo(this.actor, id, token);
  }

  static #onEdit(event, target) {
    editAppearanceDialog(this.actor, target.dataset.id);
  }

  static #onUpload() {
    pickFiles(this.actor);
  }

  static #onCapture() {
    setCaptureMode(!state.captureMode);
  }

  static #onImportUrl() {
    const input = this.element.querySelector("input[name=url]");
    addFromUrl(this.actor, input?.value);
  }

  static async #onSetTrueForm() {
    const token = canvas.tokens?.controlled.find(t => t.actor === this.actor)?.document
      ?? canvas.scene?.tokens.find(t => t.actorId === this.actor.id) ?? null;
    await setTrueFormFromToken(this.actor, token);
    emitChange(this.actor);
  }

}
