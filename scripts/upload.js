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
const TIMEOUT = 90 * 1000;

const ALLOWED_EXT = ["webp", "png", "jpg", "jpeg", "gif", "avif", "svg", "webm", "mp4", "m4v"];
const RESIZABLE = ["image/png", "image/jpeg", "image/webp", "image/avif", "image/bmp"];

const pending = new Map();   // requestId -> {resolve, reject, timer}   (requesting client)
const incoming = new Map();  // requestId -> {meta, parts, received}     (GM client)
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
 * GIFs, SVGs and videos are passed through untouched.
 * @param {File|Blob} file
 * @param {string} [label]  A human name used to build the filename.
 * @returns {Promise<File>}
 */
export async function prepareImage(file, label) {
  const type = file.type || "";
  const ext = extOf(file.name ?? "") || type.split("/")[1] || "png";
  if (!RESIZABLE.includes(type)) {
    if (!ALLOWED_EXT.includes(ext)) throw new Error(loc("Notify.BadType"));
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
    pending.set(requestId, { resolve, reject, timer });
  });

  const meta = { requestId, gmId: gm.id, userId: game.user.id, actorId: actor.id, filename: file.name, mime: file.type, total };
  for (let i = 0; i < total; i++) {
    game.socket.emit(SOCKET, { action: "upload-chunk", ...meta, index: i, data: data.slice(i * CHUNK, (i + 1) * CHUNK) });
    // Yield between chunks so the UI stays responsive on big files.
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
  }
  return promise;
}

async function gmHandleChunk(msg) {
  if (msg.gmId !== game.user.id) return;
  let entry = incoming.get(msg.requestId);
  if (!entry) {
    entry = { meta: msg, parts: new Array(msg.total), received: 0, started: Date.now() };
    incoming.set(msg.requestId, entry);
  }
  if (entry.parts[msg.index] === undefined) {
    entry.parts[msg.index] = msg.data;
    entry.received++;
  }
  if (entry.received < entry.meta.total) return;
  incoming.delete(msg.requestId);

  const reply = payload => game.socket.emit(SOCKET, { action: "upload-result", requestId: msg.requestId, userId: msg.userId, ...payload });
  try {
    const user = game.users.get(msg.userId);
    const actor = game.actors.get(msg.actorId);
    if (!user || !actor || !actor.testUserPermission(user, "OWNER")) throw new Error("Permission denied");
    if (!isChangelingActor(actor)) throw new Error(loc("Notify.NotDesignated"));
    const ext = extOf(msg.filename);
    if (!ALLOWED_EXT.includes(ext)) throw new Error(loc("Notify.BadType"));

    const b64 = entry.parts.join("");
    const bin = atob(b64);
    if (bin.length > MAX_BYTES) throw new Error(loc("Notify.TooLarge"));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // The sender already made the name unique; just sanitize it again.
    const name = safeFilename(msg.filename, ext, { suffix: false });
    const file = new File([bytes], name, { type: msg.mime || "application/octet-stream" });

    const path = await directUpload(file, uploadDirFor(actor));
    reply({ path });
  } catch (err) {
    console.error(`${MODULE_ID} | relay upload failed`, err);
    reply({ error: err.message || String(err) });
  }
}

function handleResult(msg) {
  if (msg.userId !== game.user.id) return;
  const p = pending.get(msg.requestId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.requestId);
  if (msg.path) p.resolve(msg.path);
  else p.reject(new Error(msg.error || loc("Notify.UploadFailed")));
}

export function registerUploadSocket() {
  game.socket.on(SOCKET, msg => {
    if (!msg?.action) return;
    if (msg.action === "upload-chunk" && game.user.isGM) gmHandleChunk(msg);
    else if (msg.action === "upload-result") handleResult(msg);
  });
  // Drop half-finished transfers after a while.
  setInterval(() => {
    const now = Date.now();
    for (const [id, e] of incoming) if (now - e.started > TIMEOUT * 2) incoming.delete(id);
  }, 60 * 1000);
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
