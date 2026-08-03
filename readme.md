# LighteningSend

Transfer files between two devices with no network, using animated QR codes: one screen displays them, the other's camera reads them.

This is a fork of [mohankumarelec/airgapped-qr-code-transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer), rewritten with zero third-party CDNs, native gzip streams instead of pako, raw binary QR frames, and CRC32-checked transfers.

## What's been improved

### Real-camera reliability
- **Frames now actually decode through a camera.** The old 768-byte default produced a version-22 QR that a phone could not resolve (≈3 px per module at arm's length), and error correction had been dropped to L on the mistaken theory that the CRC was enough. Error correction is back to **M**, and the default chunk is **576 bytes** (was 384 — see below).
- **Honest density ladder** labelled by cost, not size: **Safest 64 / Balanced 576 / Fast 1024 / Fastest 1536**. Safest is the only size that still decodes 100% from a distant, shaky 720p camera view; Fast and Fastest need the camera closer. Measured with `npm run sim`, which simulates a real camera headlessly — scaled, blurred, tilted, noised — and decodes with the same zbar build the receiver uses.
- **CRC on every data frame** drops bad camera reads instead of accepting them; the whole compressed stream carries its own CRC too, checked before the file is written.

### Faster receiving
- **Scan buffer shrunk 1600 → 960 → 768 px**: scan cost is the receiver's whole per-frame budget, and it is what caps frames per second. 34.5 ms at 960 px against **19.0 ms at 768 px**. Handing zbar more pixels than that does not decode more — swept 64 to 1536 byte chunks against holds from close to a shaky 60% fill, 1120 and 1600 px were never better and often worse, because zbar's binariser prefers moderate resolution to raw pixels.
- **Balanced density raised 384 → 576 bytes**, worth a flat 1.5x. The two sizes are equally robust: both decode 100% from close and arm's length, both survive a 60%-fill shaky hold, and both fail together at a distant 45% fill (where only Safest works). 384 was simply leaving bytes on the table.
- **Tiling several small QRs per frame was measured and rejected.** It looks like free parallelism — zbar returns every symbol in one scan — but the screen has a fixed module budget, and each tile pays its own 4-module quiet zone. A 2x2 grid of 384 B beat one 768 B code only in the easiest hold and collapsed to zero in every difficult one.
- **The code no longer resizes mid-transfer.** Frames differ in QR version — a header is v3, a 576 B data frame is v19 — and the canvas was sized per frame from its own module count, so in fullscreen the code jumped between 444 and 404 px every sixteenth frame (9.9%) as metadata went past. It also shrank the code: flooring to a whole number of pixels per module threw away up to a full module, drawing 404 px into 472 px of screen. CSS now pins the on-screen size and the canvas only picks a backing resolution — a whole number of pixels per module, always at least the display size, so the browser only ever scales down. Verified in real fullscreen: 37 frames, one on-screen width, and 17% more code in the same space.
- **Full screen button** hands the QR the entire display — density is limited by pixels-per-module at the camera, and the code used to be confined to the 640 px reading column. This is what makes Fast and Fastest usable: at arm's length even 2048 B decodes 100% once the code is big enough.
- **Default 12 → 15 fps, ceiling 24 → 30 fps**, now that a scan costs 19 ms and an encode 3.8 ms. Dropped frames cost nothing to a fountain code — there is no retransmit to wait for — so overshooting the receiver is cheaper than undershooting it.

### Faster sending
- **QR encoding is 5.5x cheaper: 21.0 → 3.8 ms per frame.** qrcode-generator builds the grid nine times — once per mask pattern to score it, once for real — and that ran on the main thread for every frame displayed. It was the sender's true ceiling: 21 ms per encode is ~43 fps on a desktop and well under 15 fps on a phone, so the frame rate on the slider was fiction. The mask is now fixed for data frames (`vendor/qrcode.js` is patched to accept one). Over 40 simulated holds at 576 B, every one of the 8 fixed masks decoded as well as the spec's search or better — the penalty heuristic is tuned for structured input, and gzip output is noise. The search is kept for header frames, which are structured and which the receiver cannot start without.
- **The sender paces to a deadline, not a delay.** `setTimeout(1000/fps)` slept *after* encoding, so the real period was the frame time plus a 21 ms encode: 12 fps on the slider was ~9.6 fps in fact. Now measured at exactly 15.0 fps requested-and-delivered, and 30.0 fps sustained at the new ceiling.

### Cheaper rendering
- **QR draw is 12x cheaper**: one `fillRect` per dark module cost 2.03 ms on a version-15 code; painting one pixel per module into `ImageData` and blitting with smoothing off costs 0.17 ms — on every frame shown. The blit is pixel-exact and still decodes 10/10 through a blurred, tilted camera view (`bench2.html`).
- **Measured and left alone:** the fountain's O(n²) peel costs 0.02 ms/frame decoding a 2 MB file against a 19 ms scan, so the indexed rewrite its `ponytail:` note describes is still not worth writing. Converting RGBA to greyscale ourselves to reach zbar's `scanGrayBuffer` is a net loss (31.7 ms against 29.4): our loop costs 4.6 ms to save 2.2 inside zbar. What is left per frame is the wasm scan itself.
- **The receiver's block mosaic only repaints newly solved blocks** (was: all 2000 on every frame, 1.3 ms) **and rebuilds the grid once per transfer** (was: roughly every 16 frames). One rebuild per transfer, measured.

### Text sending
- **Send text instead of a file** — a Wi-Fi password, an SSH key, a link. Same pipeline (gzip → chunk → fountain → CRC), one flag byte in the header; the receiver shows it on screen instead of saving a download.
- **Clipboard on both ends**: "Paste from clipboard" on the sender, "Copy" on the receiver, with fallbacks for browsers that deny the async clipboard API.
- Text over 100,000 characters downloads as `message.txt` instead of rendering, so a large payload can't lock the tab.

### UI
- **Redesigned in Material 3**: light-blue-grey surface family, segmented Send/Receive toggle, filter chips for QR density, filled pill primary action, 4 px determinate progress track, Material easing. Light and dark themes are tokenised; the QR keeps a white field in either because it has to scan.
- **No more idle video element**: the viewfinder stays hidden until a camera stream is attached, and hides again on stop (the old `<video>` rendered as an empty play box before Start).
- **Fixed a specificity bug the redesign exposed**: `main > section` / `.stage` display rules beat the `hidden` attribute, so the Receive panel rendered underneath Send; `[hidden]` is now enforced globally.
- **Block mosaic reads its colours from CSS custom properties** instead of hardcoded hex, so it follows the theme.

### Reliability of the transfer itself
- **Systematic LT fountain coding**: after the first pass the sender emits repair symbols forever, each the XOR of a pseudo-random block set derived from the frame id alone — nothing extra travels on the wire. Frames can arrive in any order, a missed one never has to come round again, and any `k(1+ε)` frames finish the transfer. Measured overhead 1.16–1.38x the useful frame count at 20–50% loss, vs ≈2.7x for a plain repeating loop at 50%.
- Received filenames are sanitised; decompression is capped against decompression bombs.
- Sender and receiver tuning knobs: chunk size (density) and fps — step both down if the camera is struggling.

## Screenshots

| Send | Receive |
| --- | --- |
| ![Send view](screenshots/send.png) | ![Receive view](screenshots/receive.png) |

## How it works

A single page at the root URL, with two modes: **Send** and **Receive**. Send
takes either a file or a typed message.

- **Send**: pick a file. It's gzipped with the browser's native `CompressionStream`, split into chunks, and each chunk is encoded as a QR code carrying raw binary (QR byte mode — no base64 overhead). The first pass sends every block once, so a clean transfer costs exactly one frame per block.
- **Receive**: point the camera at the sender's screen. Frames are collected in any order, and a missed one never has to come round again — see fountain coding above.
- Two tuning knobs on the send side: chunk size (QR density) and frames per second. Lower both if the receiver is struggling to keep up.

## Dependencies

Fully vendored under `vendor/` — no CDNs, works offline (open it from a USB stick):

- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 — QR encoding
- [@undecaf/zbar-wasm](https://github.com/undecaf/zbar-wasm) 0.11.0 — QR decoding (WebAssembly)

Compression/decompression uses the browser-native `CompressionStream` / `DecompressionStream` gzip APIs. No pako.

## Browser requirements

Needs `CompressionStream` and WebAssembly:

- Chrome/Edge 103+
- Safari 16.4+ (iOS 16.4+)
- Firefox 113+

Camera access requires HTTPS (or `localhost`).

## Files

- `index.html` — the app
- `app.js`, `app.css` — logic and styling
- `vendor/` — vendored dependencies
- `_headers` — Cloudflare Pages security headers
- `build.mjs` — minifies into `dist/` for deploy; the unbuilt repo still runs as-is
- `test.mjs` — protocol and fountain self-check: `npm test`
- `test.html` — QR encode/decode round-trip check; serve the directory and open it in a browser
- `sim.mjs` — headless camera simulation (scaled, blurred, tilted, noised): bytes recovered per frame and scan cost per density and scan-buffer size, `npm run sim`
- `bench.html` — in-browser decode-rate vs scan-buffer-size bench
- `bench2.html` — per-frame render-cost bench on both ends

## Deployment

Cloudflare Pages, static, no server:

```sh
npm ci
npm test
npm run deploy    # builds dist/ and uploads it
```

The build only minifies; `dist/` has the same layout as the source, so opening
`index.html` straight from the repo works identically.

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [mohankumarelec/airgapped-qr-code-transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer) — upstream project this was forked from.
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — MIT License.
- [@undecaf/zbar-wasm](https://github.com/undecaf/zbar-wasm) — LGPL-2.1 License.
