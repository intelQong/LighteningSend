// LighteningSend — airgapped file transfer over animated QR codes.
//
// Wire format (raw bytes, QR byte mode — no base64):
//
//   header frame  'H' | u8 nameLen | name(utf8) | u32 compLen | u16 chunkCount
//                     | u16 chunkSize | u32 crc32(compressed stream) | u32 crc32(frame)
//   data frame    'D' | u16 index | payload | u32 crc32(frame)
//
// crc32(frame) covers every byte before it. A bad camera read fails the CRC and
// is discarded, so a garbled frame can never corrupt the output.

import { scanImageData } from "./vendor/zbar.mjs";

const MAX_INFLATED = 512 * 1024 * 1024; // decompression-bomb ceiling
const MAX_CHUNKS = 65535; // u16 index
const HDR = 0x48; // 'H'
const DAT = 0x44; // 'D'
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

export function buildHeader(name, compLen, chunkCount, chunkSize, fileCrc) {
  const nameBytes = new TextEncoder().encode(name).slice(0, 255);
  const frame = new Uint8Array(2 + nameBytes.length + 12 + 4);
  const dv = new DataView(frame.buffer);
  frame[0] = HDR;
  frame[1] = nameBytes.length;
  frame.set(nameBytes, 2);
  let p = 2 + nameBytes.length;
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

// Returns a header/data object, or null if the frame is malformed or fails CRC.
export function parseFrame(bytes) {
  if (bytes.length < 8) return null;
  const body = bytes.length - 4;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(body) !== crc32(bytes, body)) return null;

  if (bytes[0] === DAT) {
    return { kind: "data", index: dv.getUint16(1), payload: bytes.slice(3, body) };
  }
  if (bytes[0] === HDR) {
    const nameLen = bytes[1];
    const p = 2 + nameLen;
    if (p + 12 !== body) return null;
    return {
      kind: "header",
      name: new TextDecoder().decode(bytes.subarray(2, p)),
      compLen: dv.getUint32(p),
      chunkCount: dv.getUint16(p + 4),
      chunkSize: dv.getUint16(p + 6),
      fileCrc: dv.getUint32(p + 8),
    };
  }
  return null;
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
  const btn = $("send-btn");
  const status = $("send-status");
  const canvas = $("qr");
  const fps = $("fps");
  const fpsOut = $("fps-out");
  let running = false;

  fps.addEventListener("input", () => (fpsOut.value = fps.value));

  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    fileLabel.textContent = f ? `${f.name} — ${humanSize(f.size)}` : "Choose a file…";
    btn.disabled = !f;
  });

  const stop = () => {
    running = false;
    btn.textContent = "Start transfer";
    fileInput.disabled = false;
  };

  btn.addEventListener("click", async () => {
    if (running) return stop();
    const file = fileInput.files[0];
    if (!file) return;

    running = true;
    btn.textContent = "Stop";
    fileInput.disabled = true;
    status.textContent = "Compressing…";

    let comp, chunkSize, chunkCount, header;
    try {
      comp = await gzip(await file.arrayBuffer());
      chunkSize = Number($("chunk-size").value);
      chunkCount = Math.max(1, Math.ceil(comp.length / chunkSize));
      if (chunkCount > MAX_CHUNKS) {
        throw new Error(
          `${humanSize(file.size)} needs ${chunkCount} frames. Raise QR density or send a smaller file.`
        );
      }
      header = buildHeader(
        sanitiseFilename(file.name),
        comp.length,
        chunkCount,
        chunkSize,
        crc32(comp)
      );
    } catch (err) {
      status.textContent = err.message;
      return stop();
    }

    const compressed = `${humanSize(file.size)} → ${humanSize(comp.length)}, ${chunkCount} frames`;
    let idx = 0;
    let pass = 1;
    let sinceHeader = HEADER_EVERY; // send metadata first

    // Loop the sequence forever: the receiver needs each chunk once, in any
    // order, so a missed frame is just picked up on the next pass.
    while (running) {
      let frame, label;
      if (sinceHeader >= HEADER_EVERY) {
        frame = header;
        label = "metadata";
        sinceHeader = 0;
      } else {
        frame = buildData(idx, comp.subarray(idx * chunkSize, (idx + 1) * chunkSize));
        label = `frame ${idx + 1}/${chunkCount}`;
        sinceHeader++;
        if (++idx >= chunkCount) (idx = 0), pass++;
      }
      try {
        drawQR(canvas, frame);
      } catch (err) {
        status.textContent = `QR encode failed: ${err.message}. Lower the QR density.`;
        return stop();
      }
      status.textContent = `${compressed} · ${label} · pass ${pass}`;
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
  const video = $("video");
  let stream = null;
  let running = false;

  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true });

  let meta = null;
  let chunks = new Map();

  const reset = () => {
    meta = null;
    chunks = new Map();
    bar.style.width = "0%";
    map.width = 1;
  };

  const paintMap = () => {
    if (!meta) return;
    const cols = Math.ceil(Math.sqrt(meta.chunkCount));
    const rows = Math.ceil(meta.chunkCount / cols);
    const cell = Math.max(2, Math.floor(360 / cols));
    if (map.width !== cols * cell) {
      map.width = cols * cell;
      map.height = rows * cell;
    }
    const ctx = map.getContext("2d");
    ctx.clearRect(0, 0, map.width, map.height);
    for (let i = 0; i < meta.chunkCount; i++) {
      ctx.fillStyle = chunks.has(i) ? "#4ade80" : "#2b3245";
      ctx.fillRect((i % cols) * cell, Math.floor(i / cols) * cell, cell - 1, cell - 1);
    }
    bar.style.width = `${(chunks.size / meta.chunkCount) * 100}%`;
  };

  const stop = () => {
    running = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    btn.textContent = "Start camera";
  };

  async function finish() {
    status.textContent = "Reassembling…";
    const out = new Uint8Array(meta.compLen);
    for (let i = 0; i < meta.chunkCount; i++) {
      out.set(chunks.get(i).subarray(0, meta.compLen - i * meta.chunkSize), i * meta.chunkSize);
    }
    if (crc32(out) !== meta.fileCrc) {
      // Every chunk passed its own CRC, so this means chunks from two different
      // transfers got mixed. Keep the metadata, drop the payload, resync.
      status.textContent = "Checksum mismatch — frames from two transfers mixed. Restarting.";
      chunks = new Map();
      paintMap();
      return;
    }
    try {
      download(await gunzipCapped(out), sanitiseFilename(meta.name));
      status.textContent = `Saved ${sanitiseFilename(meta.name)} — checksum verified.`;
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
            paintMap();
          } else if (
            meta &&
            frame.index < meta.chunkCount &&
            frame.payload.length <= meta.chunkSize &&
            !chunks.has(frame.index)
          ) {
            chunks.set(frame.index, frame.payload);
            paintMap();
          }
        }

        if (meta) {
          status.textContent =
            chunks.size === meta.chunkCount
              ? "Complete."
              : `${sanitiseFilename(meta.name)} — ${chunks.size}/${meta.chunkCount} frames`;
          if (chunks.size === meta.chunkCount) return finish();
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
    await video.play().catch(() => {});
    running = true;
    btn.textContent = "Stop";
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
