import { MODULE_ID, FLAGS, setting, loc, escapeHTML } from "./constants.js";

const CHANGELING_RE = /changeling|metamorf|shape\s*-?\s*changer|mudan[çc]a\s+de\s+forma|transmorf/i;

/* ------------------------------------------------------------------ */
/*  Actor resolution                                                   */
/* ------------------------------------------------------------------ */

/**
 * Heuristic used only to hint the GM (species/feature named like a changeling). It grants nothing by itself.
 */
export function looksLikeChangeling(actor) {
  if (!actor) return false;
  const race = actor.system?.details?.race;
  const raceName = typeof race === "string" ? race : race?.name;
  if (raceName && CHANGELING_RE.test(raceName)) return true;
  return actor.items?.some(i => CHANGELING_RE.test(i.name)) ?? false;
}

/** Ids of the actors the GM designated as changelings (world setting — only the GM can change it). */
export function changelingIds() {
  return new Set(setting("changelings") ?? []);
}

/** Has the GM designated this actor as a changeling? (Synthetic token actors share their base actor's id.) */
export function isChangelingActor(actor) {
  return !!actor && changelingIds().has(actor.id);
}

/** Should the HUD button / tools be offered for this actor to the current user? */
export function canUseOn(actor) {
  return !!actor?.isOwner && isChangelingActor(actor);
}

/** Does this user own at least one designated changeling? Decides whether any of the UI shows up at all. */
export function hasAnyChangeling(user = game.user) {
  const ids = changelingIds();
  if (!ids.size) return false;
  return game.actors.some(a => ids.has(a.id) && a.testUserPermission(user, "OWNER"));
}

/** GM only: designate or undesignate an actor as a changeling. */
export async function setChangeling(actor, enabled) {
  if (!game.user.isGM || !actor) return;
  const ids = changelingIds();
  if (enabled) ids.add(actor.id);
  else ids.delete(actor.id);
  await game.settings.set(MODULE_ID, "changelings", [...ids]);
  ui.notifications.info(loc(enabled ? "GM.Designated" : "GM.Undesignated", { name: escapeHTML(actor.name) }));
}

/**
 * Find "my changeling": the token passed in, a controlled owned token, or the user's assigned character.
 * @returns {{actor: Actor, token: TokenDocument|null}|null}
 */
export function resolveChangeling(token = null) {
  const doc = token?.document ?? token;
  if (doc?.actor && canUseOn(doc.actor)) return { actor: doc.actor, token: doc };
  const ctl = (canvas?.tokens?.controlled ?? []).find(t => canUseOn(t.actor));
  if (ctl) return { actor: ctl.actor, token: ctl.document };
  const tokenFor = a => canvas?.scene?.tokens.find(t => t.actorId === a.id) ?? null;
  const ch = game.user.character;
  if (ch && canUseOn(ch)) return { actor: ch, token: tokenFor(ch) };
  const ids = changelingIds();
  const owned = game.actors.find(a => ids.has(a.id) && a.isOwner && (game.user.isGM || a.type === "character"))
    ?? game.actors.find(a => ids.has(a.id) && a.isOwner);
  return owned ? { actor: owned, token: tokenFor(owned) } : null;
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
