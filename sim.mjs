// Camera simulation, headless: node sim.mjs [trials]
//
// Renders each density as a real QR, projects it into a 1080p sensor frame
// (scaled, rotated, defocused, noised), downscales it the way the receiver
// does, and asks zbar to decode it. Reports bytes recovered per camera frame
// and the scan cost that caps the receiver's frame rate — the two numbers
// whose product is throughput. This is what picked SCAN_MAX and the ladder.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildData } from "./app.js";

// zbar.mjs takes a node branch that its own bundler broke (it reaches for a
// `createRequire` that isn't in the frozen namespace object it looks in). The
// browser branch is fine, so steer it there and hand it the wasm directly.
const patched = join(tmpdir(), "zbar-node.mjs");
writeFileSync(
  patched,
  readFileSync("./vendor/zbar.mjs", "utf8").replace(
    `"object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node`,
    "false"
  )
);
const { scanGrayBuffer, setModuleArgs } = await import(patched);
setModuleArgs({ wasmBinary: readFileSync("./vendor/zbar.wasm").buffer });
(0, eval)(readFileSync("./vendor/qrcode.js", "utf8"));
const qrcode = globalThis.qrcode;

const SENSOR_W = 1920, SENSOR_H = 1080;

const latin1 = (b) => {
  let s = "";
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode.apply(null, b.subarray(i, i + 4096));
  return s;
};

function renderTiles(frames, t, quiet, scale) {
  const codes = frames.map((f) => {
    const q = qrcode(0, "M");
    q.addData(latin1(f), "Byte");
    q.make();
    return q;
  });
  const n = Math.max(...codes.map((c) => c.getModuleCount()));
  const tile = (n + quiet * 2) * scale;
  const w = tile * t;
  const px = new Uint8Array(w * w).fill(255);
  codes.forEach((q, k) => {
    const cnt = q.getModuleCount();
    const ox = (k % t) * tile + quiet * scale, oy = Math.floor(k / t) * tile + quiet * scale;
    for (let r = 0; r < cnt; r++)
      for (let c = 0; c < cnt; c++)
        if (q.isDark(r, c))
          for (let y = 0; y < scale; y++) {
            const row = (oy + r * scale + y) * w;
            px.fill(0, row + ox + c * scale, row + ox + (c + 1) * scale);
          }
  });
  return { px, w, modules: (n + quiet * 2) * t, version: (n - 17) / 4 };
}

function boxBlur(buf, w, h, radius) {
  const r = Math.round(radius);
  if (r < 1) return;
  const tmp = new Float32Array(buf.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i;
        if (xx >= 0 && xx < w) (s += buf[y * w + xx]), c++;
      }
      tmp[y * w + x] = s / c;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i;
        if (yy >= 0 && yy < h) (s += tmp[yy * w + x]), c++;
      }
      buf[y * w + x] = s / c;
    }
}

// One 1080p sensor frame of the sheet: scaled, rotated, defocused, noisy.
function sensorFrame(src, srcW, { fill, rotate, blur, noise }, rnd) {
  const out = new Float32Array(SENSOR_W * SENSOR_H).fill(90);
  const target = SENSOR_H * fill, k = srcW / target;
  const a = (rotate * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = SENSOR_W / 2, cy = SENSOR_H / 2, half = target / 2;
  const r = k > 1 ? Math.ceil(k / 2) : 0; // only box-average when minifying
  for (let y = 0; y < SENSOR_H; y++)
    for (let x = 0; x < SENSOR_W; x++) {
      const dx = x - cx, dy = y - cy;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      if (u < -half || u >= half || v < -half || v >= half) continue;
      const sx = Math.round((u + half) * k), sy = Math.round((v + half) * k);
      let sum = 0, cnt = 0;
      for (let j = -r; j <= r; j++) {
        const yy = sy + j;
        if (yy < 0 || yy >= srcW) continue;
        for (let i = -r; i <= r; i++) {
          const xx = sx + i;
          if (xx < 0 || xx >= srcW) continue;
          sum += src[yy * srcW + xx];
          cnt++;
        }
      }
      out[y * SENSOR_W + x] = cnt ? sum / cnt : 255;
    }
  boxBlur(out, SENSOR_W, SENSOR_H, blur);
  if (noise) for (let i = 0; i < out.length; i++) out[i] += (rnd() - 0.5) * noise;
  return out;
}

function downscale(sensor, cap) {
  const s = Math.min(1, cap / SENSOR_W);
  const dw = Math.round(SENSOR_W * s), dh = Math.round(SENSOR_H * s);
  const out = new Uint8Array(dw * dh), bx = 1 / s;
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++) {
      let sum = 0, cnt = 0;
      for (let j = 0; j < bx; j++)
        for (let i = 0; i < bx; i++) {
          const yy = Math.min(SENSOR_H - 1, (y * bx + j) | 0), xx = Math.min(SENSOR_W - 1, (x * bx + i) | 0);
          sum += sensor[yy * SENSOR_W + xx];
          cnt++;
        }
      out[y * dw + x] = Math.max(0, Math.min(255, sum / cnt));
    }
  return { out, dw, dh };
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONDS = {
  close: { fill: 0.9, rotate: 3, blur: 1.2, noise: 10 },
  arm: { fill: 0.75, rotate: 6, blur: 1.6, noise: 12 },
  hard: { fill: 0.6, rotate: 9, blur: 2.2, noise: 16 },
  awful: { fill: 0.45, rotate: 11, blur: 2.8, noise: 20 },
};
const CAPS = [768, 1120, 1600];
const CONFIGS = [[1, 64], [1, 576], [1, 1024], [1, 1536]];
const TRIALS = Number(process.argv[2] || 4);
const rnd = mulberry(7);

const time = new Map(); // cap -> [ms]
for (const [name, cond] of Object.entries(CONDS)) {
  console.log(`\n${name}  (fill ${cond.fill}, blur ${cond.blur}px)   bytes recovered per camera frame`);
  console.log("  tiles bytes  ver  px/module@1080p " + CAPS.map((c) => String(c).padStart(7)).join(""));
  for (const [t, bytes] of CONFIGS) {
    const cells = t * t;
    const rows = new Map(CAPS.map((c) => [c, 0]));
    let version = 0, ppm = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const frames = Array.from({ length: cells }, (_, i) => {
        const p = new Uint8Array(bytes);
        for (let j = 0; j < bytes; j++) p[j] = (j * 31 + i * 17 + trial * 7) & 0xff;
        return buildData(trial * cells + i, p);
      });
      const sheet = renderTiles(frames, t, 4, 3);
      version = sheet.version;
      ppm = ((SENSOR_H * cond.fill) / sheet.modules).toFixed(1);
      const sensor = sensorFrame(sheet.px, sheet.w, cond, rnd);
      for (const cap of CAPS) {
        const { out, dw, dh } = downscale(sensor, cap);
        const t0 = performance.now();
        const syms = await scanGrayBuffer(out.buffer, dw, dh);
        const dt = performance.now() - t0;
        time.set(cap, [...(time.get(cap) || []), dt]);
        const wanted = new Set(frames.map((f) => f.join(",")));
        let got = 0;
        for (const s of syms) if (wanted.delete(new Uint8Array(s.data.buffer.slice(0)).join(","))) got += bytes;
        rows.set(cap, rows.get(cap) + got);
      }
    }
    console.log(
      `  ${String(t + "x" + t).padStart(5)} ${String(bytes).padStart(5)}  v${String(version).padStart(2)} ${String(ppm).padStart(15)} ` +
        CAPS.map((c) => String(Math.round(rows.get(c) / TRIALS)).padStart(7)).join("")
    );
  }
}
console.log("\n  scan cost");
for (const cap of CAPS) {
  const a = time.get(cap);
  console.log(`    ${String(cap).padStart(4)} px  ${(a.reduce((x, y) => x + y) / a.length).toFixed(1)} ms/frame`);
}
