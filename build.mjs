// Builds dist/ for deployment: minified, same file layout, no bundling.
//
// Deliberately does not bundle. The module graph stays exactly as the source
// has it, so what ships is what the tests exercised — and the unbuilt repo
// still runs straight from disk, which is the whole point of an offline tool.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const OUT = "dist";

await rm(OUT, { recursive: true, force: true });
await mkdir(`${OUT}/vendor`, { recursive: true });

const target = ["es2022", "safari16.4"];

await build({
  entryPoints: ["app.js", "app.css"],
  outdir: OUT,
  outbase: ".",
  bundle: false, // keep ./vendor/zbar.mjs as a real import
  minify: true,
  format: "esm",
  target,
  logLevel: "info",
});

// Copied, not minified:
//   qrcode.js — a UMD file loaded by a plain <script>, so it must keep its
//     global. Both minify paths lose it (a module build renames the binding,
//     an IIFE build can't see through the UMD wrapper to re-export it), and
//     it gzips to ~13 kB anyway.
//   zbar.mjs — already minified upstream; reprocessing an emscripten bundle
//     buys nothing and risks plenty.
for (const f of [
  "index.html",
  "_headers",
  "vendor/qrcode.js",
  "vendor/zbar.mjs",
  "vendor/zbar.wasm",
]) {
  await cp(f, `${OUT}/${f}`);
}

console.log(`built ${OUT}/`);
