// Copies the FFmpeg WebAssembly core from node_modules into public/, so the browser loads it from
// this site instead of a CDN. Runs before `next dev` and `next build`; the copies are git-ignored.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "node_modules/@ffmpeg/core/package.json"), "utf8"));
const source = join(root, "node_modules/@ffmpeg/core/dist/esm");
// The version is part of the path, so browsers can cache the 32 MB file forever.
const target = join(root, "public/ffmpeg", pkg.version);

mkdirSync(target, { recursive: true });
for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  if (!existsSync(join(source, file))) throw new Error(`@ffmpeg/core is missing ${file}; run npm install.`);
  copyFileSync(join(source, file), join(target, file));
}
console.log(`FFmpeg core ${pkg.version} copied to public/ffmpeg/${pkg.version}/`);
