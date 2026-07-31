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


// --- Fountain: the receiver must finish without ever re-seeing a lost block ---
import { Fountain, repairIndices } from "./app.js";

function xorInto(a, b) {
  for (let i = 0; i < a.length; i++) a[i] ^= b[i];
}

// Deterministic "which frames does the camera miss" mask, so this test can't flake.
function lossy(seed) {
  let s = seed >>> 0;
  return () => ((s ^= s << 13), (s >>>= 0), (s ^= s >>> 17), (s ^= s << 5), (s >>>= 0), s / 2 ** 32);
}

for (const [k, blockSize, lossRate] of [
  [32, 768, 0.3],
  [128, 768, 0.5],
  [300, 256, 0.2],
  [1, 768, 0.5],
]) {
  const src = new Uint8Array(k * blockSize);
  for (let i = 0; i < src.length; i++) src[i] = (i * 131 + k) & 0xff;
  const block = (i) => src.subarray(i * blockSize, (i + 1) * blockSize);

  const drop = lossy(0xc0ffee + k);
  const f = new Fountain(k, blockSize);
  let sent = 0;

  // Systematic pass, then repair symbols — exactly what the sender emits.
  for (let i = 0; i < k && !f.done; i++, sent++) {
    if (drop() < lossRate) continue; // camera missed this frame
    f.add([i], block(i));
  }
  for (let id = 1; !f.done; id++, sent++) {
    assert.ok(sent < k * 20, `k=${k}: did not converge after ${sent} frames`);
    if (drop() < lossRate) continue;
    const ids = repairIndices(id, k);
    const payload = new Uint8Array(blockSize);
    for (const i of ids) xorInto(payload, block(i));
    f.add(ids, payload);
  }

  assert.deepEqual(f.assemble(src.length), src, `k=${k}: reassembled bytes differ`);
  const overhead = ((sent * (1 - lossRate)) / k).toFixed(2);
  console.log(
    `ok — k=${k}, ${lossRate * 100}% frame loss: recovered from ${sent} sent (${overhead}x useful frames)`
  );
}

// Sender and receiver must derive identical block sets from the frame id alone.
for (const k of [7, 64, 500]) {
  for (const id of [1, 2, 99, 4294967295]) {
    assert.deepEqual(repairIndices(id, k), repairIndices(id, k));
    assert.ok(repairIndices(id, k).every((i) => i >= 0 && i < k), `k=${k} id=${id}: index out of range`);
  }
}
console.log("ok — repair index derivation is deterministic and in range");
