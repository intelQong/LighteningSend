// Protocol self-check: node test.mjs
// Covers the parts that can silently corrupt a file — CRC, frame codec, filename.
import assert from "node:assert/strict";
import { crc32, buildHeader, buildData, parseFrame, sanitiseFilename } from "./app.js";

// CRC32 against the known check value for "123456789".
assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);

// Data frame round-trips, including high bytes and index 0.
for (const index of [0, 1, 65535]) {
  const payload = Uint8Array.from({ length: 768 }, (_, i) => (i * 7 + index) & 0xff);
  const f = parseFrame(buildData(index, payload));
  assert.equal(f.kind, "data");
  assert.equal(f.index, index);
  assert.deepEqual(f.payload, payload);
}

// Header round-trips, including a non-ASCII name.
const h = parseFrame(buildHeader("réçu ⚡.tar.gz", 123456, 999, 768, 0xdeadbeef));
assert.deepEqual(h, {
  kind: "header",
  name: "réçu ⚡.tar.gz",
  compLen: 123456,
  chunkCount: 999,
  chunkSize: 768,
  fileCrc: 0xdeadbeef,
});

// Any single-bit flip must be rejected, not silently accepted.
const good = buildData(42, Uint8Array.from([1, 2, 3, 250, 251, 252]));
for (let i = 0; i < good.length; i++) {
  const bad = good.slice();
  bad[i] ^= 0x01;
  assert.equal(parseFrame(bad), null, `bit flip at byte ${i} slipped through`);
}

// Truncated and unknown frames are rejected rather than throwing.
assert.equal(parseFrame(new Uint8Array(4)), null);
assert.equal(parseFrame(new Uint8Array(40)), null);

// Filenames from the wire can't escape the download directory.
assert.equal(sanitiseFilename("../../etc/passwd"), "passwd");
assert.equal(sanitiseFilename("C:\\Windows\\evil.exe"), "evil.exe");
assert.equal(sanitiseFilename("my report (final) v2.tar.gz"), "my report (final) v2.tar.gz");
assert.equal(sanitiseFilename(""), "received.bin");
assert.equal(sanitiseFilename("...."), "received.bin");
assert.equal(sanitiseFilename("report.pdf"), "report.pdf");

console.log("ok — protocol self-check passed");

