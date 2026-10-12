import assert from "node:assert/strict";
import { transcribeChunk, TranscriptionError } from "../app/transcription-client.ts";

const audio = new File([new Uint8Array(128)], "segment.aac", { type: "audio/aac" });
const cases = [
  {
    name: "empty then success",
    statuses: [
      [422, { code: "EMPTY_TRANSCRIPT", usage: { inputTokens: 15, costUsd: 0.001 } }],
      [200, { transcript: "Recovered words", usage: { inputTokens: 15, costUsd: 0.001 } }],
    ],
    text: "Recovered words", usages: 2, retries: 1,
  },
  {
    name: "rate limit then success",
    statuses: [
      [429, { code: "RATE_LIMITED", retryAfter: 31 }],
      [200, { transcript: "Okay", usage: { inputTokens: 9 } }],
    ],
    text: "Okay", usages: 1, retries: 1,
  },
  {
    name: "temporary upstream error",
    statuses: [
      [503, { code: "UPSTREAM_ERROR" }],
      [200, { transcript: "Test done" }],
    ],
    text: "Test done", usages: 0, retries: 1,
  },
];

for (const test of cases) {
  let attempts = 0, usages = 0;
  const delays = [];
  const send = async () => {
    const [status, body] = test.statuses[attempts++];
    return new Response(JSON.stringify(body), { status });
  };
  const result = await transcribeChunk(audio, () => {}, () => { usages++; }, send, async (ms) => { delays.push(ms); });
  assert.equal(result.transcript, test.text);
  assert.equal(usages, test.usages);
  assert.equal(attempts, test.statuses.length);
  assert.equal(delays.length, test.retries);
  if (test.name.includes("rate limit")) assert.equal(delays[0], 31000);
  console.log("PASS " + test.name);
}

{
  let attempts = 0;
  await assert.rejects(
    transcribeChunk(audio, () => {}, () => {}, async () => {
      attempts++;
      return new Response(JSON.stringify({code:"EMPTY_TRANSCRIPT"}), {status:422});
    }, async () => {}),
    (error) => error instanceof TranscriptionError && error.code === "EMPTY_TRANSCRIPT"
  );
  assert.equal(attempts, 2);
  console.log("PASS persistent empty is explicit and resumable");
}
