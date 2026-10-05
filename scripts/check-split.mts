// Runs the browser's FFmpeg WebAssembly core in Node on a generated 20-minute WAV with the app's
// exact conversion arguments, to check that long recordings split into parts under the upload limit.
// Usage: npx tsx scripts/check-split.mts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHUNK_SECONDS, MAX_UPLOAD_BYTES, conversionArgs } from "../lib/audio";

const require = createRequire(import.meta.url);
// The package's "exports" hide dist/umd, so resolve the files by path.
const coreDir = new URL("../node_modules/@ffmpeg/core/dist/umd/", import.meta.url);
const corePath = fileURLToPath(new URL("ffmpeg-core.js", coreDir));
const wasmPath = fileURLToPath(new URL("ffmpeg-core.wasm", coreDir));


/** 16-bit mono 16 kHz WAV of a quiet tone. */
function wav(seconds: number, rate = 16000) {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return buf;
}

// The core is built for browser workers: give it `self` and the wasm bytes instead of a fetch.
(globalThis as { self?: unknown }).self = globalThis;
(globalThis as { location?: unknown }).location ??= { href: pathToFileURL(corePath).href };
const createCore = require(corePath);
const core = await createCore({ wasmBinary: readFileSync(wasmPath), print: () => {}, printErr: () => {} });

const minutes = 20;
core.FS.writeFile("input.wav", wav(minutes * 60));
const started = Date.now();
core.exec(...conversionArgs("input.wav"));
const parts: string[] = core.FS.readdir("/").filter((n: string) => /^part\d{3}\.mp3$/.test(n)).sort();
const sizes: number[] = parts.map((n) => core.FS.stat(n).size);

console.log(`${minutes}-minute recording → ${parts.length} parts in ${((Date.now() - started) / 1000).toFixed(1)} s (part length ${CHUNK_SECONDS / 60} min)`);
parts.forEach((n, i) => console.log(`  ${n}: ${(sizes[i] / 1048576).toFixed(2)} MB`));
const expected = Math.ceil((minutes * 60) / CHUNK_SECONDS);
const ok = parts.length === expected && sizes.every((s) => s > 0 && s < MAX_UPLOAD_BYTES);
console.log(ok ? `OK: ${expected} parts, all under ${MAX_UPLOAD_BYTES / 1048576} MB` : "FAILED");
process.exit(ok ? 0 : 1);
