import { MODULE_ID, SOCKET, loc, setting, FilePickerImpl } from "./constants.js";
import { isChangelingActor } from "./store.js";

/*
 * Players usually lack the "Upload New Files" permission on a hosted game. Uploads therefore go:
 *   1. directly through FilePicker.upload when the user is allowed to (and the GM allows direct mode), or
 *   2. through the connected GM's client: the image is shrunk, split in chunks, sent over the module socket,
 *      reassembled and uploaded by the GM, who replies with the final path.
 */

const CHUNK = 192 * 1024;            // characters of base64 per socket message
const MAX_BYTES = 25 * 1024 * 1024;  // hard cap on any single upload
const MAX_B64 = Math.ceil(MAX_BYTES / 3) * 4;
const MAX_CHUNKS = Math.ceil(MAX_B64 / CHUNK);
const TIMEOUT = 90 * 1000;

// GM-side abuse limits (per sending user unless noted)
const MAX_CONCURRENT_PER_USER = 2;
const MAX_CONCURRENT_TOTAL = 8;
const RATE_WINDOW = 10 * 60 * 1000;
const MAX_TRANSFERS_PER_WINDOW = 20;

/** Raster types the client re-encodes to WebP; GIF and video pass through. SVG is never accepted. */
const RESIZABLE = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/bmp"];
const PASSTHROUGH_EXT = ["gif", "webm", "mp4", "m4v"];

const pending = new Map();   // requestId -> {resolve, reject, timer, gmId}   (requesting client)
const incoming = new Map();  // requestId -> transfer being reassembled        (GM client)
const history = new Map();   // userId -> timestamps of transfers started      (GM client)
const madeDirs = new Set();

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

function cleanSegment(s) {
  return String(s ?? "").trim().replace(/^\/+|\/+$/g, "").replace(/\.\.+/g, "").replace(/[^\w\-/ ]/g, "_");
}

export function uploadDirFor(actor) {
  const base = cleanSegment(setting("uploadPath")) || "changeling-faces";
  const world = cleanSegment(game.world.id);
  const slug = (actor.name ?? "actor").slugify({ strict: true }) || "actor";
  return `${base}/${world}/${slug}-${actor.id}`;
}

function sourceAndBody() {
  const source = setting("uploadSource");
  const body = {};
  if (source === "s3") body.bucket = setting("uploadBucket");
  return { source, body };
}

function safeFilename(name, ext, { suffix = true } = {}) {
  const stem = String(name || "rosto").replace(/\.[^.]+$/, "").slugify({ strict: true }).slice(0, 48) || "rosto";
  return suffix ? `${stem}-${foundry.utils.randomID(6)}.${ext}` : `${stem}.${ext}`;
}

function extOf(name) {
  return (String(name).split(".").pop() || "").toLowerCase().replace(/\?.*$/, "");
}

/* ------------------------------------------------------------------ */
/*  Image preparation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Downscale large raster images and re-encode as WebP to keep uploads (and socket traffic) small.
 * GIFs and videos are passed through untouched; anything else (SVG included) is refused.
 * @param {File|Blob} file
 * @param {string} [label]  A human name used to build the filename.
 * @returns {Promise<File>}
 */
export async function prepareImage(file, label) {
  const type = file.type || "";
  const ext = extOf(file.name ?? "") || type.split("/")[1] || "png";
  if (!RESIZABLE.includes(type)) {
    if (!PASSTHROUGH_EXT.includes(ext)) throw new Error(loc("Notify.BadType"));
    if (file.size > MAX_BYTES) throw new Error(loc("Notify.TooLarge"));
    return new File([file], safeFilename(label ?? file.name, ext), { type });
  }

  const max = setting("maxImageSize");
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));
  const canvasEl = document.createElement("canvas");
  canvasEl.width = w;
  canvasEl.height = h;
  const ctx = canvasEl.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  let quality = 0.9;
  let blob = await new Promise(r => canvasEl.toBlob(r, "image/webp", quality));
  while (blob && blob.size > 4 * 1024 * 1024 && quality > 0.5) {
    quality -= 0.15;
    blob = await new Promise(r => canvasEl.toBlob(r, "image/webp", quality));
  }
  if (!blob) throw new Error(loc("Notify.BadType"));
  return new File([blob], safeFilename(label ?? file.name, "webp"), { type: "image/webp" });
}

/* ------------------------------------------------------------------ */
/*  Upload entry point                                                 */
/* ------------------------------------------------------------------ */

async function ensureDirectory(source, dir, body) {
  const FP = FilePickerImpl();
  const parts = dir.split("/").filter(Boolean);
  let path = "";
  for (const p of parts) {
    path = path ? `${path}/${p}` : p;
    const key = `${source}:${body.bucket ?? ""}:${path}`;
    if (madeDirs.has(key)) continue;
    try {
      await FP.createDirectory(source, path, body);
    } catch (err) {
      // Most likely "already exists" — anything else surfaces on upload.
    }
    madeDirs.add(key);
  }
}

async function directUpload(file, dir) {
  const { source, body } = sourceAndBody();
  await ensureDirectory(source, dir, body);
  const res = await FilePickerImpl().upload(source, dir, file, body, { notify: false });
  if (!res?.path) throw new Error(res?.message || loc("Notify.UploadFailed"));
  return res.path;
}

/**
 * Upload an image for the given changeling actor and return its path.
 * @param {Actor} actor
 * @param {File} file   A prepared file (see prepareImage)
 */
export async function uploadForActor(actor, file) {
  const canDirect = setting("uploadMode") === "auto" && game.user.can("FILES_UPLOAD");
  if (canDirect || game.user.isGM) return directUpload(file, uploadDirFor(actor));
  return relayUpload(actor, file);
}

/* ------------------------------------------------------------------ */
/*  Relay through the GM                                               */
/* ------------------------------------------------------------------ */

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function relayUpload(actor, file) {
  const gm = game.users.activeGM;
  if (!gm) throw new Error(loc("Notify.NoGM"));
  if (file.size > MAX_BYTES) throw new Error(loc("Notify.TooLarge"));

  const data = await fileToBase64(file);
  const requestId = foundry.utils.randomID(16);
  const total = Math.ceil(data.length / CHUNK) || 1;

  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(loc("Notify.UploadTimeout")));
    }, TIMEOUT);
    pending.set(requestId, { resolve, reject, timer, gmId: gm.id });
  });

  // Sent to the GM only — other players never see the image data or the request id.
  const meta = { requestId, actorId: actor.id, filename: file.name, total };
  for (let i = 0; i < total; i++) {
    game.socket.emit(SOCKET, { action: "upload-chunk", ...meta, index: i, data: data.slice(i * CHUNK, (i + 1) * CHUNK) },
      { recipients: [gm.id] });
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
  }
  return promise;
}

/* ---------------- GM side ---------------- */

/** Identify the file type from its first bytes; the name/mime the sender claims are ignored. */
export function sniffType(bytes) {
  const b = i => bytes[i];
  const ascii = (from, len) => String.fromCharCode(...bytes.subarray(from, from + len));
  if (bytes.length < 12) return null;
  if (b(0) === 0x89 && ascii(1, 3) === "PNG") return { ext: "png", mime: "image/png" };
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return { ext: "jpg", mime: "image/jpeg" };
  if (ascii(0, 4) === "GIF8") return { ext: "gif", mime: "image/gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (b(0) === 0x1A && b(1) === 0x45 && b(2) === 0xDF && b(3) === 0xA3) return { ext: "webm", mime: "video/webm" };
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (brand === "avif" || brand === "avis") return { ext: "avif", mime: "image/avif" };
    return { ext: "mp4", mime: "video/mp4" };
  }
  return null;
}

function rateLimited(userId) {
  const now = Date.now();
  const recent = (history.get(userId) ?? []).filter(t => now - t < RATE_WINDOW);
  history.set(userId, recent);
  if (recent.length >= MAX_TRANSFERS_PER_WINDOW) return true;
  recent.push(now);
  return false;
}

const isId = v => typeof v === "string" && /^[A-Za-z0-9]{1,32}$/.test(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/**
 * Validate a chunk coming from `senderId` (the authenticated user id the server attaches to every module
 * socket message — ids written inside the payload are never trusted).
 * @returns {string|null}  An error message, or null if the chunk was accepted.
 */
function acceptChunk(msg, senderId) {
  if (!isId(msg.requestId) || !isId(msg.actorId)) return "Bad request";
  if (!isInt(msg.total, 1, MAX_CHUNKS) || !isInt(msg.index, 0, msg.total - 1)) return "Bad request";
  if (typeof msg.data !== "string" || msg.data.length > CHUNK || !/^[A-Za-z0-9+/=]*$/.test(msg.data)) return "Bad request";
  if (typeof msg.filename !== "string" || msg.filename.length > 200) return "Bad request";

  let entry = incoming.get(msg.requestId);
  if (entry) {
    // Later chunks must belong to the same sender and transfer.
    if (entry.senderId !== senderId || entry.actorId !== msg.actorId || entry.total !== msg.total) return "Bad request";
  } else {
    const user = game.users.get(senderId);
    const actor = game.actors.get(msg.actorId);
    if (!user || !actor || !actor.testUserPermission(user, "OWNER")) return "Permission denied";
    if (!isChangelingActor(actor)) return loc("Notify.NotDesignated");
    const mine = [...incoming.values()].filter(e => e.senderId === senderId).length;
    if (mine >= MAX_CONCURRENT_PER_USER || incoming.size >= MAX_CONCURRENT_TOTAL) return loc("Notify.Busy");
    if (rateLimited(senderId)) return loc("Notify.RateLimited");
    entry = {
      senderId, actorId: msg.actorId, total: msg.total, filename: msg.filename,
      parts: new Array(msg.total), received: 0, size: 0, last: Date.now()
    };
    incoming.set(msg.requestId, entry);
  }

  if (entry.parts[msg.index] === undefined) {
    entry.size += msg.data.length;
    if (entry.size > MAX_B64) {
      incoming.delete(msg.requestId);
      return loc("Notify.TooLarge");
    }
    entry.parts[msg.index] = msg.data;
    entry.received++;
  }
  entry.last = Date.now();
  return null;
}

async function gmHandleChunk(msg, senderId) {
  // Only the active GM handles relays, and only for messages with a server-verified sender.
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  if (!senderId || senderId === game.user.id) return;

  const reply = payload => game.socket.emit(SOCKET, { action: "upload-result", requestId: String(msg.requestId), ...payload },
    { recipients: [senderId] });

  const error = acceptChunk(msg, senderId);
  if (error) return reply({ error });

  const entry = incoming.get(msg.requestId);
  if (entry.received < entry.total) return;
  incoming.delete(msg.requestId);

  try {
    const actor = game.actors.get(entry.actorId);
    const bin = atob(entry.parts.join(""));
    if (bin.length > MAX_BYTES) throw new Error(loc("Notify.TooLarge"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type = sniffType(bytes);
    if (!type) throw new Error(loc("Notify.BadType"));
    // The GM picks the final name: sanitized label + its own random suffix, extension from the real content.
    const file = new File([bytes], safeFilename(entry.filename, type.ext), { type: type.mime });
    const path = await directUpload(file, uploadDirFor(actor));
    reply({ path });
  } catch (err) {
    console.warn(`${MODULE_ID} | relay upload from ${game.users.get(senderId)?.name ?? senderId} rejected: ${err.message ?? err}`);
    reply({ error: err.message || String(err) });
  }
}

function handleResult(msg, senderId) {
  const p = pending.get(msg.requestId);
  if (!p) return;
  // Only the GM we sent the request to may answer it.
  if (!senderId || senderId !== p.gmId) return;
  clearTimeout(p.timer);
  pending.delete(msg.requestId);
  if (typeof msg.path === "string" && msg.path) p.resolve(msg.path);
  else p.reject(new Error(typeof msg.error === "string" ? msg.error : loc("Notify.UploadFailed")));
}

export function registerUploadSocket() {
  game.socket.on(SOCKET, (msg, senderId) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.action === "upload-chunk") gmHandleChunk(msg, senderId);
    else if (msg.action === "upload-result") handleResult(msg, senderId);
  });
  // Drop stalled transfers.
  setInterval(() => {
    const now = Date.now();
    for (const [id, e] of incoming) if (now - e.last > TIMEOUT) incoming.delete(id);
  }, 30 * 1000);
}

/* ------------------------------------------------------------------ */
/*  Fetching remote URLs                                               */
/* ------------------------------------------------------------------ */

export async function fetchUrlAsFile(url) {
  let res;
  try {
    res = await fetch(url, { mode: "cors" });
  } catch (err) {
    throw new Error(loc("Notify.CorsBlocked"));
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const blob = await res.blob();
  if (!/^image\/|^video\//.test(blob.type)) throw new Error(loc("Notify.BadType"));
  const name = decodeURIComponent(new URL(url).pathname.split("/").pop() || "imagem");
  const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  return new File([blob], /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${ext}`, { type: blob.type });
}
