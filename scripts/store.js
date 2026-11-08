import { MODULE_ID, FLAGS, setting } from "./constants.js";

const CHANGELING_RE = /changeling|metamorf|shape\s*-?\s*changer|mudan[çc]a\s+de\s+forma|transmorf/i;

/* ------------------------------------------------------------------ */
/*  Actor resolution                                                   */
/* ------------------------------------------------------------------ */

/** Does this actor look like a changeling (species item / feature named like one, or flagged)? */
export function isChangelingActor(actor) {
  if (!actor) return false;
  const flag = actor.getFlag(MODULE_ID, FLAGS.ENABLED);
  if (flag === true) return true;
  if (flag === false) return false;
  const race = actor.system?.details?.race;
  const raceName = typeof race === "string" ? race : race?.name;
  if (raceName && CHANGELING_RE.test(raceName)) return true;
  return actor.items?.some(i => CHANGELING_RE.test(i.name)) ?? false;
}

/** Should the HUD button / tools be offered for this actor to the current user? */
export function canUseOn(actor) {
  if (!actor?.isOwner) return false;
  if (isChangelingActor(actor)) return true;
  if (actor.getFlag(MODULE_ID, FLAGS.ENABLED) === false) return false;
  // Players: any character they own. GM: only actors detected/flagged as changelings.
  return !game.user.isGM && setting("allCharacters") && actor.type === "character";
}

/**
 * Find "my changeling": the token passed in, a controlled owned token, or the user's assigned character.
 * @returns {{actor: Actor, token: TokenDocument|null}|null}
 */
export function resolveChangeling(token = null) {
  const doc = token?.document ?? token;
  if (doc?.actor && canUseOn(doc.actor)) return { actor: doc.actor, token: doc };
  const controlled = canvas?.tokens?.controlled ?? [];
  const ctl = controlled.find(t => canUseOn(t.actor) && isChangelingActor(t.actor))
    ?? controlled.find(t => canUseOn(t.actor));
  if (ctl) return { actor: ctl.actor, token: ctl.document };
  const ch = game.user.character;
  if (ch && canUseOn(ch)) {
    const tok = canvas?.scene?.tokens.find(t => t.actorLink && t.actorId === ch.id) ?? null;
    return { actor: ch, token: tok };
  }
  if (game.user.isGM) {
    const flagged = game.actors.find(a => a.getFlag(MODULE_ID, FLAGS.ENABLED) === true);
    if (flagged) return { actor: flagged, token: canvas?.scene?.tokens.find(t => t.actorId === flagged.id) ?? null };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Snapshots                                                          */
/* ------------------------------------------------------------------ */

/** Capture the visual identity of a TokenDocument (or prototype token). */
export function snapshotToken(doc, { includeName = true } = {}) {
  const data = doc.toObject();
  const texture = foundry.utils.deepClone(data.texture ?? {});
  delete texture.rotation;
  return {
    name: includeName ? data.name : "",
    texture,
    ring: data.ring ? foundry.utils.deepClone(data.ring) : null,
    portrait: doc.actor?.img ?? null
  };
}

/* ------------------------------------------------------------------ */
/*  Appearance CRUD (stored on the changeling actor)                    */
/* ------------------------------------------------------------------ */

export function getAppearances(actor) {
  return foundry.utils.deepClone(actor?.getFlag(MODULE_ID, FLAGS.APPEARANCES) ?? []);
}

export function getAppearance(actor, id) {
  return getAppearances(actor).find(a => a.id === id) ?? null;
}

export function getTrueForm(actor) {
  return foundry.utils.deepClone(actor?.getFlag(MODULE_ID, FLAGS.TRUE_FORM) ?? null);
}

export function getCurrentId(actor) {
  return actor?.getFlag(MODULE_ID, FLAGS.CURRENT) ?? null;
}

export async function saveAppearances(actor, list) {
  const update = { [`flags.${MODULE_ID}.${FLAGS.APPEARANCES}`]: list };
  Object.assign(update, tvaSyncUpdate(actor, list));
  return actor.update(update);
}

export async function addAppearance(actor, data) {
  const list = getAppearances(actor);
  const entry = {
    id: foundry.utils.randomID(),
    name: data.name || "?",
    useName: data.useName ?? true,
    kind: data.kind ?? "token",
    texture: data.texture,
    ring: data.ring ?? null,
    portrait: data.portrait ?? null,
    created: Date.now()
  };
  list.push(entry);
  await saveAppearances(actor, list);
  return entry;
}

export async function updateAppearance(actor, id, changes) {
  const list = getAppearances(actor);
  const entry = list.find(a => a.id === id);
  if (!entry) return null;
  foundry.utils.mergeObject(entry, changes);
  await saveAppearances(actor, list);
  return entry;
}

export async function removeAppearance(actor, id) {
  const list = getAppearances(actor).filter(a => a.id !== id);
  await saveAppearances(actor, list);
}

export async function moveAppearance(actor, id, toIndex) {
  const list = getAppearances(actor);
  const from = list.findIndex(a => a.id === id);
  if (from < 0) return;
  const [entry] = list.splice(from, 1);
  list.splice(Math.clamp(toIndex, 0, list.length), 0, entry);
  await saveAppearances(actor, list);
}

/* ------------------------------------------------------------------ */
/*  Token Variant Art integration                                      */
/* ------------------------------------------------------------------ */

/**
 * Build the flag changes that mirror our appearances into TVA's "shared variants" list,
 * so they also show up in TVA's own HUD palette when that module is installed.
 */
function tvaSyncUpdate(actor, list) {
  if (!game.modules.get("token-variants")?.active) return {};
  if (!setting("syncTVA")) return {};
  const ours = new Set(actor.getFlag(MODULE_ID, FLAGS.TVA_SYNCED) ?? []);
  const existing = (actor.getFlag("token-variants", "variants") ?? []).filter(v => !ours.has(v.imgSrc));
  const bySrc = new Map();
  for (const a of list) {
    const src = a.texture?.src;
    if (!src || existing.some(v => v.imgSrc === src)) continue;
    if (!bySrc.has(src)) bySrc.set(src, []);
    bySrc.get(src).push(a.name);
  }
  const added = [...bySrc.entries()].map(([imgSrc, names]) => ({ imgSrc, names }));
  return {
    "flags.token-variants.variants": [...existing, ...added],
    [`flags.${MODULE_ID}.${FLAGS.TVA_SYNCED}`]: added.map(v => v.imgSrc)
  };
}
