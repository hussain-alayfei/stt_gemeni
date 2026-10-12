// Regression test: generate actual AAC-in-MP4 media, extract the audio,
// and verify that FFmpeg can decode the returned ADTS stream.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareMedia } from "../app/media-processing.ts";

const temp = mkdtempSync(path.join(tmpdir(), "stt-mp4-test-"));
const ff = (args) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "pipe" });
const test = async (name, duration, video) => {
  const mp4 = path.join(temp, name + ".mp4");
  const args = video
    ? ["-f","lavfi","-i",`testsrc2=size=640x360:rate=24:duration=${duration}`,
       "-f","lavfi","-i",`sine=frequency=440:sample_rate=48000:duration=${duration}`,
       "-c:v","mpeg4","-b:v","3M","-c:a","aac","-b:a","96k","-shortest","-movflags","+faststart",mp4]
    : ["-f","lavfi","-i",`sine=frequency=440:sample_rate=16000:duration=${duration}`,
       "-c:a","aac","-b:a","32k",mp4];
  ff(args);
  // Emulate a 260 MiB MP4 with a trailing moov atom without expensive video
  // encoding: add a standards-compliant 'free' box before the final moov.
  if (name === "long-recording") {
    const original = readFileSync(mp4);
    let position = 0, moov = -1;
    while (position + 8 <= original.length) {
      const size = original.readUInt32BE(position);
      const kind = original.toString("ascii", position + 4, position + 8);
      if (kind === "moov") { moov = position; break; }
      if (size < 8) break;
      position += size;
    }
    assert(moov > 0, "Expected a trailing MP4 metadata atom.");
    const size = 260 * 1024 * 1024;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(size, 0);
    header.write("free", 4);
    writeFileSync(mp4, Buffer.concat([
      original.subarray(0, moov),
      header,
      Buffer.alloc(size - 8),
      original.subarray(moov),
    ]));
  }
  const input = new File([new Uint8Array(readFileSync(mp4))], name+".mp4", {type:"video/mp4"});
  let percent=0;
  const chunks = await prepareMedia(input, n=>{percent=n;});
  assert(chunks.length >= (duration>360?2:1), "Chunk count must reflect media length");
  assert.equal(percent, 100);
  for (let i=0;i<chunks.length;i++) {
    assert.equal(chunks[i].type,"audio/aac");
    assert(chunks[i].size>0 && chunks[i].size<4*1024*1024);
    const out = path.join(temp,`audio-${name}-${i}.aac`);
    writeFileSync(out, new Uint8Array(await chunks[i].arrayBuffer()));
    ff(["-f","aac","-i",out,"-f","null","-"]);
  }
  console.log(`PASS ${name}: ${input.size} video bytes -> ${chunks.length} valid AAC chunk(s)`);
};

try {
  await test("video",8,true);
  await test("long-recording",367,false);
} finally { rmSync(temp,{recursive:true,force:true}); }
