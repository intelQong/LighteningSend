# LighteningSend

Transfer files between two devices with no network, using animated QR codes: one screen displays them, the other's camera reads them.

Live at [lighteningsend.intelqong.link](https://lighteningsend.intelqong.link).

This is a fork of [mohankumarelec/airgapped-qr-code-transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer), rewritten with zero third-party CDNs, native gzip streams instead of pako, raw binary QR frames, and CRC32-checked transfers.

## How it works

A single page at the root URL, with two modes: **Send** and **Receive**.

- **Send**: pick a file. It's gzipped with the browser's native `CompressionStream`, split into chunks, and each chunk is encoded as a QR code carrying raw binary (QR byte mode — no base64 overhead). The sender loops the frame sequence forever.
- **Receive**: point the camera at the sender's screen. Frames are collected in any order; each chunk only needs to be seen once, so a missed frame is just picked up on the next loop. There's no restarting a transfer.
- Every data frame carries a CRC32, so a bad camera read is dropped rather than accepted. The full compressed stream carries its own CRC32 too, checked before the file is written to disk.
- Two tuning knobs on the send side: chunk size (QR density) and frames per second. Lower both if the receiver is struggling to keep up.
- Received filenames are sanitised, and decompression is capped to guard against decompression bombs.

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
- `test.mjs` — protocol self-check: `node test.mjs`
- `test.html` — QR encode/decode round-trip check; serve the directory and open it in a browser

## Deployment

Static site, no build step. Deployed to Cloudflare Pages:

```sh
npx wrangler pages deploy . --project-name=lighteningsend
```

## License

MIT — see [LICENSE](LICENSE).

## Credits

- [mohankumarelec/airgapped-qr-code-transfer](https://github.com/mohankumarelec/airgapped-qr-code-transfer) — upstream project this was forked from.
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — MIT License.
- [@undecaf/zbar-wasm](https://github.com/undecaf/zbar-wasm) — LGPL-2.1 License.
