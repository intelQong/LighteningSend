// LighteningSend — airgapped file transfer over animated QR codes.
//
// Wire format (raw bytes, QR byte mode — no base64):
//
//   header frame  'H' | u8 flags | u8 nameLen | name(utf8) | u32 compLen
//                     | u16 chunkCount | u16 chunkSize | u32 crc32(compressed stream)
//                     | u32 crc32(frame)
//                     flags bit 0: payload is UTF-8 text, to show rather than save
//   data frame    'D' | u16 index | payload | u32 crc32(frame)
//   repair frame  'R' | u32 frameId | payload | u32 crc32(frame)
//
// crc32(frame) covers every byte before it. A bad camera read fails the CRC and
// is discarded, so a garbled frame can never corrupt the output.
//
// A repair frame's payload is the XOR of a set of blocks derived from frameId
// alone, so the receiver reconstructs the same set without being told it.

import { scanImageData } from "./vendor/zbar.mjs";

const MAX_INFLATED = 512 * 1024 * 1024; // decompression-bomb ceiling
const MAX_CHUNKS = 65535; // u16 index
const HDR = 0x48; // 'H'
const DAT = 0x44; // 'D'
const REP = 0x52; // 'R'
const HEADER_EVERY = 16; // re-broadcast metadata this often, so a late receiver catches up

// ---------------------------------------------------------------- utilities

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, len = bytes.length) {
  let c = 0xffffffff;
  for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// qrcode-generator's default stringToBytes is `charCodeAt(i) & 0xff`, so a
// latin1 string round-trips to the exact bytes in QR byte mode.
function bytesToLatin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  }
  return s;
}

// The name arrives over the wire from another device, so treat it as hostile:
// keep only the final path segment, then drop anything a filesystem dislikes.
export function sanitiseFilename(name) {
  const clean = String(name ?? "")
    .split(/[/\\]/)
    .pop()
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 200);
  return clean || "received.bin";
}

function humanSize(n) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

async function gzip(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function gunzipCapped(bytes, cap = MAX_INFLATED) {
  const reader = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      throw new Error(`Refusing to decompress past ${humanSize(cap)}.`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

// ------------------------------------------------------------ frame codec

export function buildHeader(name, compLen, chunkCount, chunkSize, fileCrc, isText = false) {
  const nameBytes = new TextEncoder().encode(name).slice(0, 255);
  const frame = new Uint8Array(3 + nameBytes.length + 12 + 4);
  const dv = new DataView(frame.buffer);
  frame[0] = HDR;
  frame[1] = isText ? 1 : 0;
  frame[2] = nameBytes.length;
  frame.set(nameBytes, 3);
  let p = 3 + nameBytes.length;
  dv.setUint32(p, compLen);
  dv.setUint16(p + 4, chunkCount);
  dv.setUint16(p + 6, chunkSize);
  dv.setUint32(p + 8, fileCrc);
  dv.setUint32(p + 12, crc32(frame, p + 12));
  return frame;
}

export function buildData(index, payload) {
  const frame = new Uint8Array(3 + payload.length + 4);
  const dv = new DataView(frame.buffer);
  frame[0] = DAT;
  dv.setUint16(1, index);
  frame.set(payload, 3);
  dv.setUint32(frame.length - 4, crc32(frame, frame.length - 4));
  return frame;
}

export function buildRepair(frameId, payload) {
  const frame = new Uint8Array(5 + payload.length + 4);
  const dv = new DataView(frame.buffer);
  frame[0] = REP;
  dv.setUint32(1, frameId);
  frame.set(payload, 5);
  dv.setUint32(frame.length - 4, crc32(frame, frame.length - 4));
  return frame;
}

// Returns a header/data object, or null if the frame is malformed or fails CRC.
export function parseFrame(bytes) {
  if (bytes.length < 8) return null;
  const body = bytes.length - 4;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(body) !== crc32(bytes, body)) return null;

  if (bytes[0] === DAT) {
    return { kind: "data", index: dv.getUint16(1), payload: bytes.slice(3, body) };
  }
  if (bytes[0] === REP) {
    return { kind: "repair", frameId: dv.getUint32(1), payload: bytes.slice(5, body) };
  }
  if (bytes[0] === HDR) {
    const nameLen = bytes[2];
    const p = 3 + nameLen;
    if (p + 12 !== body) return null;
    return {
      kind: "header",
      isText: (bytes[1] & 1) === 1,
      name: new TextDecoder().decode(bytes.subarray(3, p)),
      compLen: dv.getUint32(p),
      chunkCount: dv.getUint16(p + 4),
      chunkSize: dv.getUint16(p + 6),
      fileCrc: dv.getUint32(p + 8),
    };
  }
  return null;
}

// ------------------------------------------------- fountain (systematic LT)
//
// Pass 1 sends every block once, so a clean transfer still costs exactly k
// frames. After that the sender emits repair symbols forever: each is the XOR
// of a pseudo-random set of blocks, and the receiver peels them to recover
// whatever it missed. Any k(1+ε) frames will do — it never has to wait for one
// specific frame to come round again.
//
// Both sides derive the same block set from the frame id alone, so nothing but
// the id has to travel on the wire.

function xorshift32(seed) {
  // Frame ids are consecutive small integers, and xorshift seeded with those
  // produces near-identical streams — repair sets would overlap and the decode
  // would stall. Run the seed through splitmix32's finaliser first.
  let s = seed >>> 0;
  s ^= s >>> 16;
  s = Math.imul(s, 0x21f0aaad) >>> 0;
  s ^= s >>> 15;
  s = Math.imul(s, 0x735a2d97) >>> 0;
  s ^= s >>> 15;
  s = s >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

// Robust soliton distribution (Luby). Cached — it only depends on k.
const solitonCache = new Map();
function solitonCdf(k) {
  let cdf = solitonCache.get(k);
  if (cdf) return cdf;
  const c = 0.03;
  const delta = 0.5;
  const R = c * Math.log(k / delta) * Math.sqrt(k);
  const p = new Float64Array(k + 1);
  p[1] = 1 / k;
  for (let i = 2; i <= k; i++) p[i] = 1 / (i * (i - 1));
  const kr = Math.floor(k / R);
  for (let i = 1; i < kr; i++) p[i] += R / (i * k);
  if (kr >= 1 && kr <= k) p[kr] += (R * Math.log(R / delta)) / k;
  let sum = 0;
  for (let i = 1; i <= k; i++) sum += p[i];
  cdf = new Float64Array(k + 1);
  let acc = 0;
  for (let i = 1; i <= k; i++) (acc += p[i] / sum), (cdf[i] = acc);
  solitonCache.set(k, cdf);
  return cdf;
}

export function repairIndices(frameId, k) {
  const rnd = xorshift32(frameId);
  const cdf = solitonCdf(k);
  const u = rnd();
  let d = 1;
  while (d < k && cdf[d] < u) d++;
  const ids = new Set();
  while (ids.size < d) ids.add(Math.floor(rnd() * k) % k);
  return [...ids];
}

function xorInto(a, b) {
  for (let i = 0; i < a.length; i++) a[i] ^= b[i];
}

export class Fountain {
  constructor(k, blockSize) {
    this.k = k;
    this.blockSize = blockSize;
    this.solved = new Map();
    this.pending = [];
  }

  get done() {
    return this.solved.size === this.k;
  }

  // ids: block indices XORed into data. A systematic block is just ids=[i].
  add(ids, data) {
    if (data.length !== this.blockSize) return;
    const eq = { ids: new Set(ids), data: data.slice() };
    this.#reduce(eq);
    if (eq.ids.size === 0) return; // nothing new
    this.pending.push(eq);
    this.#peel();
  }

  #reduce(eq) {
    for (const i of [...eq.ids]) {
      const s = this.solved.get(i);
      if (s) {
        xorInto(eq.data, s);
        eq.ids.delete(i);
      }
    }
  }

  // ponytail: O(n^2) peel over the pending list. Fine to a few thousand blocks;
  // swap in an index from block -> equations if that ever becomes the bottleneck.
  #peel() {
    for (let progress = true; progress; ) {
      progress = false;
      for (let j = 0; j < this.pending.length; j++) {
        const eq = this.pending[j];
        this.#reduce(eq);
        if (eq.ids.size === 1) {
          const i = eq.ids.values().next().value;
          if (!this.solved.has(i)) {
            this.solved.set(i, eq.data);
            progress = true;
          }
        }
        if (eq.ids.size <= 1) this.pending.splice(j--, 1);
      }
    }
  }

  assemble(compLen) {
    const out = new Uint8Array(compLen);
    for (let i = 0; i < this.k; i++) {
      const at = i * this.blockSize;
      out.set(this.solved.get(i).subarray(0, Math.min(this.blockSize, compLen - at)), at);
    }
    return out;
  }
}

// ------------------------------------------------------------------ send

const $ = (id) => document.getElementById(id);

function drawQR(canvas, frame) {
  const qr = qrcode(0, "L"); // auto version, low EC — payload already CRC-guarded
  qr.addData(bytesToLatin1(frame), "Byte");
  qr.make();

  const count = qr.getModuleCount();
  const quiet = 4;
  const target = Math.min(window.innerWidth, window.innerHeight * 0.7) * 0.95;
  const scale = Math.max(2, Math.floor(target / (count + quiet * 2)));
  const size = (count + quiet * 2) * scale;

  if (canvas.width !== size) (canvas.width = size), (canvas.height = size);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  for (let r = 0; r < count; r++) {
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }
}

function initSend() {
  const fileInput = $("file-input");
  const fileLabel = $("file-label");
  const textInput = $("text-input");
  const btn = $("send-btn");
  const status = $("send-status");
  const canvas = $("qr");
  const stage = $("qr-stage");
  const fps = $("fps");
  const fpsOut = $("fps-out");
  let running = false;

  fps.addEventListener("input", () => (fpsOut.value = fps.value));

  // Which source is active is owned by the File/Text switch below.
  let source = "file";
  const refresh = () => {
    btn.disabled = running
      ? false
      : source === "file"
        ? !fileInput.files[0]
        : textInput.value.trim().length === 0;
  };

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    fileLabel.textContent = f ? `${f.name} · ${humanSize(f.size)}` : "Choose a file";
    refresh();
  });
  const pasteBtn = $("paste-btn");
  const clearBtn = $("clear-btn");

  const afterTextChange = () => {
    clearBtn.hidden = textInput.value.length === 0;
    refresh();
  };
  textInput.addEventListener("input", afterTextChange);

  pasteBtn.addEventListener("click", async () => {
    try {
      // Firefox has no readText for pages, and any browser can deny permission.
      const text = await navigator.clipboard.readText();
      if (!text) {
        status.textContent = "Clipboard is empty.";
        return;
      }
      textInput.value = text;
      afterTextChange();
      status.textContent = "Pasted from clipboard.";
    } catch {
      textInput.focus();
      status.textContent = "Your browser won't share the clipboard. Press Ctrl+V (or Cmd+V) instead.";
    }
  });

  clearBtn.addEventListener("click", () => {
    textInput.value = "";
    textInput.focus();
    afterTextChange();
  });

  const sources = [
    [$("src-file"), $("source-file"), "file"],
    [$("src-text"), $("source-text"), "text"],
  ];
  for (const [tab, panel, key] of sources) {
    tab.addEventListener("click", () => {
      if (running) return;
      source = key;
      for (const [t, p, k] of sources) {
        t.setAttribute("aria-selected", String(k === key));
        p.hidden = k !== key;
      }
      status.textContent =
        key === "text" ? "Write something to get started." : "Pick a file to get started.";
      refresh();
    });
  }

  const stop = () => {
    running = false;
    stage.hidden = true;
    btn.textContent = "Start transfer";
    fileInput.disabled = false;
    textInput.disabled = false;
    pasteBtn.disabled = false;
    refresh();
  };

  btn.addEventListener("click", async () => {
    if (running) return stop();

    // Text rides the same pipeline as a file; only the header flag differs.
    const isText = source === "text";
    const file = fileInput.files[0];
    const raw = isText ? new TextEncoder().encode(textInput.value) : null;
    if (isText ? raw.length === 0 : !file) return;

    const sourceName = isText ? "message.txt" : file.name;
    const sourceSize = isText ? raw.length : file.size;

    running = true;
    btn.textContent = "Stop";
    fileInput.disabled = true;
    textInput.disabled = true;
    pasteBtn.disabled = true;
    status.textContent = "Compressing…";

    let comp, blocks, chunkSize, chunkCount, header;
    try {
      comp = await gzip(isText ? raw : await file.arrayBuffer());
      chunkSize = Number(document.querySelector('input[name="density"]:checked').value);
      chunkCount = Math.max(1, Math.ceil(comp.length / chunkSize));
      if (chunkCount > MAX_CHUNKS) {
        throw new Error(
          `${humanSize(sourceSize)} needs ${chunkCount} frames. Raise QR density or send less.`
        );
      }
      header = buildHeader(
        sanitiseFilename(sourceName),
        comp.length,
        chunkCount,
        chunkSize,
        crc32(comp),
        isText
      );
      // Repair symbols XOR whole blocks, so every block must be full width.
      blocks = new Uint8Array(chunkCount * chunkSize);
      blocks.set(comp);
    } catch (err) {
      status.textContent = err.message;
      return stop();
    }

    const compressed = `${humanSize(sourceSize)} → ${humanSize(comp.length)}, ${chunkCount} frames`;
    const block = (i) => blocks.subarray(i * chunkSize, (i + 1) * chunkSize);
    let idx = 0; // systematic pass position
    let frameId = 1; // repair symbol id, never reused
    let sinceHeader = HEADER_EVERY; // send metadata first

    // Pass 1 is systematic (every block once). After that, repair symbols
    // forever — the receiver can finish on any k(1+ε) of them.
    while (running) {
      let frame, label;
      if (sinceHeader >= HEADER_EVERY) {
        frame = header;
        label = "metadata";
        sinceHeader = 0;
      } else if (idx < chunkCount) {
        frame = buildData(idx, block(idx));
        label = `block ${idx + 1}/${chunkCount}`;
        sinceHeader++;
        idx++;
      } else {
        const ids = repairIndices(frameId, chunkCount);
        const payload = new Uint8Array(chunkSize);
        for (const i of ids) xorInto(payload, block(i));
        frame = buildRepair(frameId, payload);
        label = `repair ${frameId} (${ids.length} blocks)`;
        sinceHeader++;
        frameId++;
      }
      try {
        drawQR(canvas, frame);
        stage.hidden = false;
      } catch (err) {
        status.textContent = `QR encode failed: ${err.message}. Lower the QR density.`;
        return stop();
      }
      status.textContent = `${compressed} · ${label}`;
      await new Promise((r) => setTimeout(r, 1000 / Number(fps.value)));
    }
    status.textContent = `Stopped. ${compressed}`;
  });
}

// --------------------------------------------------------------- receive

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function initReceive() {
  const btn = $("recv-btn");
  const status = $("recv-status");
  const bar = $("recv-bar");
  const map = $("recv-map");
  const progress = $("recv-progress");
  const video = $("video");
  const viewfinder = $("viewfinder");
  const textCard = $("recv-text");
  const textBody = $("recv-text-body");
  const copyBtn = $("copy-btn");
  let stream = null;
  let running = false;

  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true });

  let meta = null;
  let fountain = null;
  let framesSeen = 0;

  const reset = () => {
    meta = null;
    fountain = null;
    framesSeen = 0;
    bar.style.width = "0%";
    map.width = 1;
    progress.hidden = true;
  };

  const paintMap = () => {
    if (!meta) return;
    progress.hidden = false;
    const cols = Math.ceil(Math.sqrt(meta.chunkCount));
    const rows = Math.ceil(meta.chunkCount / cols);
    const cell = Math.max(2, Math.floor(360 / cols));
    if (map.width !== cols * cell) {
      map.width = cols * cell;
      map.height = rows * cell;
    }
    const ctx = map.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const on = css.getPropertyValue("--received");
    const off = css.getPropertyValue("--pending");
    ctx.clearRect(0, 0, map.width, map.height);
    for (let i = 0; i < meta.chunkCount; i++) {
      ctx.fillStyle = fountain.solved.has(i) ? on : off;
      ctx.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell - 1, cell - 1);
    }
    bar.style.width = `${(fountain.solved.size / meta.chunkCount) * 100}%`;
  };

  const stop = () => {
    running = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    viewfinder.hidden = true;
    btn.textContent = "Start camera";
  };

  const MAX_SHOWN_TEXT = 100_000;

  // The async clipboard API needs a secure context and can be denied outright,
  // so fall back to the old selection-based copy rather than giving up.
  const legacyCopy = (text) => {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(scratch);
    scratch.select();
    scratch.setSelectionRange(0, text.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    scratch.remove();
    return ok;
  };

  copyBtn.addEventListener("click", async () => {
    const text = textBody.textContent;
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    copyBtn.textContent = ok ? "Copied" : "Press Ctrl+C to copy";
    if (!ok) getSelection().selectAllChildren(textBody);
    setTimeout(() => (copyBtn.textContent = "Copy"), ok ? 2000 : 4000);
  });

  async function finish() {
    status.textContent = "Reassembling…";
    const out = fountain.assemble(meta.compLen);
    if (crc32(out) !== meta.fileCrc) {
      // Every frame passed its own CRC, so this means frames from two different
      // transfers got mixed. Keep the metadata, drop the payload, resync.
      status.textContent = "Checksum mismatch — frames from two transfers mixed. Restarting.";
      fountain = new Fountain(meta.chunkCount, meta.chunkSize);
      paintMap();
      return;
    }
    try {
      const payload = await gunzipCapped(out);
      const name = sanitiseFilename(meta.name);
      const text = meta.isText ? new TextDecoder().decode(payload) : null;

      if (text !== null && text.length <= MAX_SHOWN_TEXT) {
        textBody.textContent = text;
        textCard.hidden = false;
        status.textContent = "Message received — checksum verified.";
      } else {
        download(payload, name);
        status.textContent = `Saved ${name} — checksum verified.`;
      }
    } catch (err) {
      status.textContent = `Decompression failed: ${err.message}`;
    }
    stop();
    reset();
  }

  async function tick() {
    if (!running) return;
    try {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w && h) {
        // Cap the scan buffer — full 4K frames cost far more than they decode.
        const s = Math.min(1, 1600 / Math.max(w, h));
        const sw = Math.round(w * s);
        const sh = Math.round(h * s);
        if (scratch.width !== sw) (scratch.width = sw), (scratch.height = sh);
        sctx.drawImage(video, 0, 0, sw, sh);

        for (const sym of await scanImageData(sctx.getImageData(0, 0, sw, sh))) {
          const frame = parseFrame(new Uint8Array(sym.data.buffer.slice(0)));
          if (!frame) continue;

          if (frame.kind === "header") {
            if (meta && meta.fileCrc !== frame.fileCrc) reset(); // new transfer started
            meta = frame;
            fountain ??= new Fountain(frame.chunkCount, frame.chunkSize);
            paintMap();
          } else if (!meta) {
            // Metadata hasn't arrived yet; it repeats every few frames.
            continue;
          } else if (frame.kind === "data" && frame.index < meta.chunkCount) {
            framesSeen++;
            fountain.add([frame.index], frame.payload);
            paintMap();
          } else if (frame.kind === "repair") {
            framesSeen++;
            fountain.add(repairIndices(frame.frameId, meta.chunkCount), frame.payload);
            paintMap();
          }
        }

        if (meta) {
          const got = fountain.solved.size;
          status.textContent = fountain.done
            ? "Complete."
            : `${sanitiseFilename(meta.name)} — ${got}/${meta.chunkCount} blocks (${framesSeen} frames read)`;
          if (fountain.done) return finish();
        }
      }
    } catch (err) {
      console.error("scan:", err);
    }
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  }

  btn.addEventListener("click", async () => {
    if (running) {
      stop();
      reset();
      status.textContent = "Stopped.";
      return;
    }
    try {
      // Camera opens only on an explicit click, never on page load.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
    } catch (err) {
      status.textContent = `Camera unavailable: ${err.message}`;
      return;
    }
    video.srcObject = stream;
    viewfinder.hidden = false;
    await video.play().catch(() => {});
    running = true;
    btn.textContent = "Stop";
    textCard.hidden = true;
    status.textContent = "Scanning — point at the sender's screen.";
    reset();
    tick();
  });
}

// ------------------------------------------------------------------- boot

function initTabs() {
  const tabs = [
    [$("tab-send"), $("panel-send")],
    [$("tab-recv"), $("panel-recv")],
  ];
  for (const [tab, panel] of tabs) {
    tab.addEventListener("click", () => {
      for (const [t, p] of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        p.hidden = !on;
      }
      location.hash = panel === tabs[1][1] ? "#receive" : "#send";
    });
  }
  if (location.hash === "#receive") tabs[1][0].click();
}

if (typeof window !== "undefined" && document.getElementById("qr")) {
  if (!window.CompressionStream) {
    const main = document.querySelector("main");
    main.textContent =
      "This browser is missing CompressionStream. Needs Chrome 103+, Safari 16.4+, or Firefox 113+.";
    main.className = "status";
  } else {
    initTabs();
    initSend();
    initReceive();
  }
}
