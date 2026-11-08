import { MODULE_ID, FLAGS, TRUE_FORM_ID, loc, setting, escapeHTML } from "./constants.js";
import { getAppearance, getTrueForm, getCurrentId, snapshotToken, canUseOn } from "./store.js";

/** Tokens of this actor that should change together (in the currently viewed scene). */
function tokensFor(actor, token) {
  const set = new Map();
  if (token?.parent === canvas.scene) set.set(token.id, token);
  if (actor.isToken) {
    if (actor.token?.parent === canvas.scene) set.set(actor.token.id, actor.token);
  } else if (canvas.scene) {
    for (const t of canvas.scene.tokens) {
      if (t.actorLink && t.actorId === actor.id) set.set(t.id, t);
    }
  }
  return [...set.values()];
}

/**
 * Build a token-data diff for a given look.
 * @param {object} look       {name, texture, ring, kind, useName}
 * @param {object|null} base  The true form, used to fill in texture fields an uploaded image does not define.
 */
function buildTokenChanges(look, base, { isTrueForm = false } = {}) {
  const changes = {};
  let texture = pickFields(look.texture, TEXTURE_FIELDS);
  if (look.kind === "upload" && base?.texture) {
    // Uploaded art only defines src + scale; inherit the rest (anchor, fit, tint...) from the true form.
    texture = { ...pickFields(base.texture, TEXTURE_FIELDS), ...texture };
  }
  for (const [k, v] of Object.entries(texture)) changes[`texture.${k}`] = v;

  if (look.ring && typeof look.ring === "object") {
    const flat = foundry.utils.flattenObject(look.ring);
    for (const [k, v] of Object.entries(pickFields(flat, RING_FIELDS))) changes[`ring.${k}`] = v;
  } else if (look.kind === "upload") {
    // Make sure a dynamic ring (if enabled) shows the uploaded image instead of an old subject texture.
    changes["ring.subject.texture"] = null;
  }

  if (setting("changeName") && typeof look.name === "string" && look.name
    && (isTrueForm || look.useName !== false)) {
    changes.name = look.name.slice(0, 120);
  }
  return changes;
}

/*
 * Appearance data lives in actor flags the player can write freely. Only these token fields — the ones a
 * token owner may already edit — are ever copied into an update, with the expected value types.
 */
const isNum = v => typeof v === "number" && Number.isFinite(v);
const isStr = v => typeof v === "string" && v.length <= 2048;
const isColor = v => v === null || (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v));
const TEXTURE_FIELDS = {
  src: isStr, scaleX: isNum, scaleY: isNum, anchorX: isNum, anchorY: isNum, offsetX: isNum, offsetY: isNum,
  fit: v => ["fill", "contain", "cover", "width", "height"].includes(v), tint: isColor, alphaThreshold: isNum
};
const RING_FIELDS = {
  enabled: v => typeof v === "boolean", effects: v => Number.isInteger(v) && v >= 0,
  "colors.ring": isColor, "colors.background": isColor,
  "subject.texture": v => v === null || isStr(v), "subject.scale": isNum
};
function pickFields(obj, spec) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [key, valid] of Object.entries(spec)) {
    if (Object.hasOwn(obj, key) && valid(obj[key])) out[key] = obj[key];
  }
  return out;
}

/** Keep only the flattened changes whose value differs from the document's current source data. */
function diffAgainst(doc, changes) {
  const src = doc._source ?? doc.toObject();
  const out = {};
  for (const [k, v] of Object.entries(changes)) {
    const cur = foundry.utils.getProperty(src, k);
    if ((cur ?? null) !== (v ?? null)) out[k] = v;
  }
  return out;
}

function animationOptions() {
  const transition = setting("transition");
  if (transition === "none") return { animate: false };
  return { animation: { transition, duration: setting("transitionDuration") } };
}

/**
 * Change the changeling into one of its memorized appearances (or back to its true form).
 * @param {Actor} actor
 * @param {string} appearanceId     An appearance id or TRUE_FORM_ID
 * @param {object} [options]
 * @param {TokenDocument} [options.token]  The token the user acted on.
 */
export async function applyAppearance(actor, appearanceId, { token = null, silent = false } = {}) {
  if (!actor?.isOwner) return;
  const reverting = appearanceId === TRUE_FORM_ID || !appearanceId;
  const docs = tokensFor(actor, token);

  // First transformation: remember who we really are.
  let trueForm = getTrueForm(actor);
  const actorUpdate = {};
  if (!trueForm) {
    if (reverting) {
      if (!silent) ui.notifications.warn(loc("Notify.NoTrueForm"));
      return;
    }
    const source = docs[0] ?? actor.prototypeToken;
    trueForm = snapshotToken(source);
    trueForm.portrait = actor.img;
    actorUpdate[`flags.${MODULE_ID}.${FLAGS.TRUE_FORM}`] = trueForm;
  }

  const look = reverting ? { ...trueForm, kind: "token" } : getAppearance(actor, appearanceId);
  if (!look) return;

  const changes = buildTokenChanges(look, trueForm, { isTrueForm: reverting });
  const flagKey = `flags.${MODULE_ID}.appearance`;
  changes[flagKey] = reverting ? null : look.id;

  // Tokens on the canvas
  if (docs.length) {
    // Only send what actually differs: touching ring data forces a full token redraw (and closes the HUD),
    // while a pure texture change plays the transition animation.
    const updates = docs.map(d => ({ _id: d.id, ...diffAgainst(d, changes) })).filter(u => Object.keys(u).length > 1);
    if (updates.length) await canvas.scene.updateEmbeddedDocuments("Token", updates, animationOptions());
  }

  // Prototype token (so the disguise persists when the token is placed on other scenes)
  if (!actor.isToken && setting("updatePrototype")) {
    for (const [k, v] of Object.entries(diffAgainst(actor.prototypeToken, changes))) {
      if (k === flagKey) continue;
      actorUpdate[`prototypeToken.${k}`] = v;
    }
  }

  // Portrait
  if (setting("changePortrait")) {
    const portrait = reverting ? trueForm.portrait : (look.portrait || look.texture?.src);
    if (isStr(portrait) && portrait) actorUpdate.img = portrait;
  }

  actorUpdate[`flags.${MODULE_ID}.${FLAGS.CURRENT}`] = reverting ? null : look.id;
  await actor.update(actorUpdate);

  if (setting("whisperGM") && !game.user.isGM) {
    const gms = game.users.filter(u => u.isGM).map(u => u.id);
    const content = reverting
      ? loc("Chat.Reverted", { actor: escapeHTML(actor.name) })
      : loc("Chat.Changed", { actor: escapeHTML(actor.name), face: escapeHTML(look.name) });
    ChatMessage.create({ content, whisper: gms, speaker: ChatMessage.getSpeaker({ actor }) });
  }
  return look;
}

export function revertToTrueForm(actor, options = {}) {
  return applyAppearance(actor, TRUE_FORM_ID, options);
}

/** Overwrite the stored true form with the token's current look. */
export async function setTrueFormFromToken(actor, token) {
  const source = token ?? tokensFor(actor, null)[0] ?? actor.prototypeToken;
  const tf = snapshotToken(source);
  tf.portrait = actor.img;
  await actor.update({
    [`flags.${MODULE_ID}.${FLAGS.TRUE_FORM}`]: tf,
    [`flags.${MODULE_ID}.${FLAGS.CURRENT}`]: null
  });
  ui.notifications.info(loc("Notify.TrueFormSet"));
}

/* ------------------------------------------------------------------ */
/*  "You stay in the new form until you revert or die."                */
/* ------------------------------------------------------------------ */

/** Exactly one connected client handles automatic reverts: the first active owning player, else the active GM. */
function isResponsibleClient(actor) {
  const owners = game.users
    .filter(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (owners.length) return owners[0].id === game.user.id;
  return game.users.activeGM?.id === game.user.id;
}

function maybeRevertOnDeath(actor) {
  if (!actor || !setting("revertOnDeath")) return;
  if (!getCurrentId(actor) || !isResponsibleClient(actor)) return;
  revertToTrueForm(actor, { silent: true }).then(() => {
    ui.notifications.info(loc("Notify.RevertedOnDeath", { name: escapeHTML(actor.name) }));
  });
}

export function registerDeathHooks() {
  Hooks.on("updateActor", (actor, changes) => {
    const failures = foundry.utils.getProperty(changes, "system.attributes.death.failure");
    if (Number.isNumeric(failures) && failures >= 3) maybeRevertOnDeath(actor);
  });
  Hooks.on("createActiveEffect", effect => {
    const actor = effect.parent;
    if (!(actor instanceof Actor)) return;
    const dead = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
    if (effect.statuses?.has(dead)) maybeRevertOnDeath(actor);
  });
}

export { canUseOn };
