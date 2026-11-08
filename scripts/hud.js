import { MODULE_ID, PALETTE, TRUE_FORM_ID, loc, escapeHTML, isVideo, setting } from "./constants.js";
import {
  canUseOn, getAppearances, getTrueForm, getCurrentId, isChangelingActor, setChangeling, looksLikeChangeling
} from "./store.js";
import {
  state, switchTo, pickFiles, setCaptureMode, editAppearanceDialog, addFromFiles, addFromUrl
} from "./actions.js";
import { openLibrary } from "./library.js";

/*
 * Quick-swap palette in the Token HUD, laid out like Token Variant Art's side menu:
 * a button in the right column toggles a grid of 100px portraits; left-click switches,
 * right-click edits. Uses the core "togglePalette" HUD action so it behaves like the status palette.
 */

let filterText = "";

function media(src, cls = "") {
  const s = escapeHTML(src);
  return isVideo(src)
    ? `<video class="${cls}" src="${s}" muted loop playsinline></video>`
    : `<img class="${cls}" src="${s}" alt="" loading="lazy">`;
}

function tileHTML({ id, name, src, active, trueForm }) {
  const classes = ["cf-tile"];
  if (active) classes.push("active");
  if (trueForm) classes.push("cf-true-form");
  const tooltip = trueForm ? `${loc("TrueForm")}: ${name}` : name;
  return `
    <div class="${classes.join(" ")}" data-id="${id}" data-tooltip="${escapeHTML(escapeHTML(tooltip))}" data-tooltip-direction="UP"
         data-search="${escapeHTML((name ?? "").toLowerCase())}">
      ${media(src, "cf-tile-img")}
      ${trueForm ? `<i class="cf-badge fa-solid fa-fingerprint"></i>` : ""}
      ${active ? `<i class="cf-check fa-solid fa-check"></i>` : ""}
      <span class="cf-tile-name">${escapeHTML(name)}</span>
    </div>`;
}

export function paletteInnerHTML(actor) {
  const list = getAppearances(actor);
  const tf = getTrueForm(actor);
  const current = getCurrentId(actor);
  const tiles = [];

  // True form first. Before the first transformation it is simply the token's current look.
  const tfSrc = tf?.texture?.src ?? actor.prototypeToken?.texture?.src;
  const tfName = tf?.name ?? actor.prototypeToken?.name ?? actor.name;
  if (tfSrc) tiles.push(tileHTML({ id: TRUE_FORM_ID, name: tfName, src: tfSrc, active: !current, trueForm: true }));

  for (const a of list) {
    tiles.push(tileHTML({ id: a.id, name: a.name, src: a.texture?.src, active: a.id === current }));
  }
  for (let i = 0; i < state.uploading; i++) {
    tiles.push(`<div class="cf-tile cf-uploading"><i class="fa-solid fa-spinner fa-spin"></i><span>${loc("Uploading")}</span></div>`);
  }
  tiles.push(`
    <div class="cf-tile cf-add" data-cf-action="upload" data-tooltip="${loc("HUD.UploadHint")}" data-tooltip-direction="UP">
      <i class="fa-solid fa-cloud-arrow-up"></i><span>${loc("HUD.Upload")}</span>
    </div>`);

  const toolbar = `
    <div class="cf-toolbar">
      <input type="search" class="cf-filter" placeholder="${loc("HUD.Filter")}" value="${escapeHTML(filterText)}">
      <button type="button" class="cf-tool ${state.captureMode ? "active" : ""}" data-cf-action="capture"
              data-tooltip="${loc("HUD.CaptureHint")}"><i class="fa-solid fa-eye-dropper"></i></button>
      <button type="button" class="cf-tool" data-cf-action="library" data-tooltip="${loc("HUD.LibraryHint")}">
        <i class="fa-solid fa-book-skull"></i></button>
    </div>`;

  const empty = list.length ? "" : `<p class="cf-empty">${loc("HUD.Empty")}</p>`;
  return toolbar + empty + tiles.join("");
}

function applyFilter(palette) {
  const q = filterText.trim().toLowerCase();
  for (const tile of palette.querySelectorAll(".cf-tile[data-id]")) {
    tile.classList.toggle("cf-hidden", !!q && !tile.dataset.search.includes(q) && tile.dataset.id !== TRUE_FORM_ID);
  }
}

function activateListeners(palette, hud) {
  const getActor = () => hud.document?.actor;

  palette.addEventListener("click", async event => {
    const actionEl = event.target.closest("[data-cf-action]");
    const tile = event.target.closest(".cf-tile[data-id]");
    if (!actionEl && !tile) return;
    event.preventDefault();
    event.stopPropagation();
    const actor = getActor();
    if (!actor) return;

    if (actionEl) {
      switch (actionEl.dataset.cfAction) {
        case "upload": return pickFiles(actor);
        case "capture": return setCaptureMode(!state.captureMode);
        case "library": return openLibrary(actor);
      }
      return;
    }
    if (tile.classList.contains("active")) return;
    tile.classList.add("cf-switching");
    const tokenObj = hud.object;
    await switchTo(actor, tile.dataset.id, hud.document);
    reopenIfClosed(hud, tokenObj);
  });

  palette.addEventListener("contextmenu", event => {
    const tile = event.target.closest(".cf-tile[data-id]");
    if (!tile || tile.dataset.id === TRUE_FORM_ID) return;
    event.preventDefault();
    event.stopPropagation();
    editAppearanceDialog(getActor(), tile.dataset.id);
  });

  palette.addEventListener("input", event => {
    if (!event.target.matches(".cf-filter")) return;
    filterText = event.target.value;
    applyFilter(palette);
  });
  // Keep typing in the filter from moving the token / firing hotkeys.
  palette.addEventListener("keydown", event => {
    if (event.target.matches(".cf-filter")) event.stopPropagation();
  });

  palette.addEventListener("pointerover", event => {
    const v = event.target.closest(".cf-tile")?.querySelector("video");
    v?.play?.().catch(() => {});
  });
  palette.addEventListener("pointerout", event => {
    const v = event.target.closest(".cf-tile")?.querySelector("video");
    if (v && !event.relatedTarget?.closest?.(".cf-tile")?.contains(v)) { v.pause(); v.currentTime = 0; }
  });

  // Drag & drop image files (or images dragged from a website) onto the palette.
  palette.addEventListener("dragover", event => {
    event.preventDefault();
    event.stopPropagation();
    palette.classList.add("cf-dragover");
  });
  palette.addEventListener("dragleave", () => palette.classList.remove("cf-dragover"));
  palette.addEventListener("drop", event => {
    event.preventDefault();
    event.stopPropagation();
    palette.classList.remove("cf-dragover");
    const actor = getActor();
    if (!actor) return;
    const files = event.dataTransfer?.files;
    if (files?.length) return addFromFiles(actor, files);
    const url = event.dataTransfer?.getData("text/uri-list") || event.dataTransfer?.getData("text/plain");
    if (/^https?:\/\//i.test(url ?? "")) addFromUrl(actor, url.split("\n")[0]);
  });

  palette.addEventListener("wheel", event => event.stopPropagation(), { passive: true });
}

/**
 * Some changes (e.g. dynamic ring on/off) make core redraw the token, which closes the HUD.
 * Bring the HUD and our palette back so the player can keep flipping through faces.
 */
function reopenIfClosed(hud, tokenObj) {
  if (!tokenObj) return;
  const id = tokenObj.id;
  let done = false;
  let hookId = null;
  let timer = null;
  const reopen = async () => {
    if (done) return;
    done = true;
    Hooks.off("drawToken", hookId);
    clearTimeout(timer);
    const tok = canvas.tokens?.get(id);
    if (!tok || tok.destroyed || !tok.controlled) return;
    if (!hud.rendered || hud.object !== tok) await hud.bind(tok);
    hud.togglePalette(PALETTE, true);
  };
  // Core redraws the token once the texture transition ends (closing the HUD); reopen right after.
  hookId = Hooks.on("drawToken", t => { if (t.id === id) setTimeout(reopen, 30); });
  timer = setTimeout(reopen, (Number(setting("transitionDuration")) || 900) + 2500);
}

/** GM-only toggle (left column) to designate this token's actor as a changeling. */
function addDesignationToggle(root, actor) {
  const col = root.querySelector(".col.left");
  if (!col) return;
  const on = isChangelingActor(actor);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control-icon changeling-gm-toggle";
  if (on) btn.classList.add("active");
  else if (looksLikeChangeling(actor)) btn.classList.add("cf-suggested");
  btn.dataset.tooltip = loc(on ? "GM.UndesignateHint" : "GM.DesignateHint", { name: escapeHTML(actor.name) });
  btn.setAttribute("aria-label", loc(on ? "GM.Undesignate" : "GM.Designate"));
  btn.innerHTML = `<i class="fa-solid fa-dna" inert></i>`;
  btn.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    setChangeling(actor, !on);
  });
  col.append(btn);
}

function onRenderTokenHUD(hud, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const doc = hud.document ?? hud.object?.document;
  const actor = doc?.actor;
  if (!root || !actor) return;
  if (game.user.isGM) addDesignationToggle(root, actor);
  if (!canUseOn(actor)) return;
  const col = root.querySelector(".col.right");
  if (!col) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "control-icon changeling-hud-button";
  button.dataset.action = "togglePalette";
  button.dataset.palette = PALETTE;
  button.dataset.tooltip = loc("HUD.ButtonHint");
  button.setAttribute("aria-label", loc("HUD.Button"));
  button.innerHTML = `<i class="fa-solid fa-masks-theater" inert></i>`;
  if (getCurrentId(actor)) button.classList.add("cf-disguised");
  button.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    openLibrary(actor);
  });

  const palette = document.createElement("div");
  palette.className = "palette changeling-palette";
  palette.dataset.palette = PALETTE;
  palette.dataset.actorId = actor.id;
  palette.innerHTML = paletteInnerHTML(actor);
  applyFilter(palette);
  activateListeners(palette, hud);

  col.append(button, palette);

  // Re-renders keep the palette open if it was open.
  if (hud.activePalette === PALETTE) {
    button.classList.add("active");
    palette.classList.add("active");
  }
}

/** Redraw the palette contents in place (no HUD re-render, so it stays open). */
export function refreshPalette(actor = null) {
  const hud = canvas?.tokens?.hud;
  if (!hud?.rendered) return;
  const hudActor = hud.document?.actor;
  if (!hudActor || (actor && hudActor !== actor && hudActor.id !== actor.id)) return;
  const palette = hud.element?.querySelector(`.palette[data-palette="${PALETTE}"]`);
  if (!palette) return;
  palette.innerHTML = paletteInnerHTML(hudActor);
  applyFilter(palette);
  hud.element.querySelector(".changeling-hud-button")?.classList.toggle("cf-disguised", !!getCurrentId(hudActor));
}

export function registerHUD() {
  Hooks.on("renderTokenHUD", onRenderTokenHUD);
}
