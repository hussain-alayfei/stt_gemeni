import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHUNK_BITRATE,
  CHUNK_SECONDS,
  FFMPEG_CORE_VERSION,
  MAX_UPLOAD_BYTES,
  conversionArgs,
  extensionOf,
  isRateLimitError,
  isVideo,
  joinParts,
  mimeTypeFor,
  needsConversion,
  retrySecondsFrom,
} from "../lib/audio";
import { costUsd, getPricing } from "../lib/pricing";
import { LIMITS, clientIp, rateLimit, resetRateLimits } from "../lib/rate-limit";
import { checkAccessCode, createSessionToken, readCookie, sessionCookie, verifySessionToken } from "../lib/session";

/** Runs fn with env vars set (undefined = unset), then restores them. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => unknown) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

// ---- session -------------------------------------------------------------------------------------

test("session tokens verify, expire, and stop working when the access code changes", async () => {
  await withEnv({ ACCESS_CODE: "correct horse" }, async () => {
    const now = Date.UTC(2026, 9, 5);
    const token = await createSessionToken(now);
    assert.ok(token?.startsWith("v1."));
    assert.equal(await verifySessionToken(token, now + 1000), true);
    assert.equal(await verifySessionToken(token, now + 31 * 86400_000), false, "expired after 30 days");

    const [v, exp, sig] = token!.split(".");
    assert.equal(await verifySessionToken(`${v}.${Number(exp) + 999999}.${sig}`, now), false, "edited expiry");
    assert.equal(await verifySessionToken(`${v}.${exp}.${sig.slice(0, -2)}AA`, now), false, "edited signature");
    assert.equal(await verifySessionToken("garbage", now), false);
    assert.equal(await verifySessionToken(undefined, now), false);

    process.env.ACCESS_CODE = "a new code";
    assert.equal(await verifySessionToken(token, now + 1000), false, "new code signs everyone out");
  });
  await withEnv({ ACCESS_CODE: undefined }, async () => {
    assert.equal(await createSessionToken(), undefined, "no code configured, no sessions");
  });
});

test("access code check is exact (trimmed) and fails closed", async () => {
  await withEnv({ ACCESS_CODE: "  s3cret-Code  " }, async () => {
    assert.equal(await checkAccessCode("s3cret-Code"), true);
    assert.equal(await checkAccessCode(" s3cret-Code "), true);
    assert.equal(await checkAccessCode("s3cret-code"), false, "case-sensitive");
    assert.equal(await checkAccessCode(""), false);
  });
  await withEnv({ ACCESS_CODE: undefined }, async () => {
    assert.equal(await checkAccessCode("anything"), false);
  });
});

test("cookie helpers", () => {
  assert.equal(readCookie("a=1; stt_session=v1.2.abc; b=2"), "v1.2.abc");
  assert.equal(readCookie("a=1"), undefined);
  assert.equal(readCookie(null), undefined);
  const cookie = sessionCookie("tok", true);
  for (const part of ["stt_session=tok", "HttpOnly", "SameSite=Lax", "Secure", "Path=/"]) assert.ok(cookie.includes(part), part);
  assert.ok(!sessionCookie("tok", false).includes("Secure"), "plain http (local dev) has no Secure flag");
});

// ---- rate limits ---------------------------------------------------------------------------------

test("rate limiter allows the quota, then reports the wait, then frees up", () => {
  resetRateLimits();
  const limit = { max: 3, windowMs: 60_000 };
  for (let i = 0; i < 3; i++) assert.equal(rateLimit("k", limit, 1000 + i), 0);
  const wait = rateLimit("k", limit, 2000);
  assert.ok(wait > 0 && wait <= 60, `wait ${wait}`);
  assert.equal(rateLimit("other", limit, 2000), 0, "keys are independent");
  assert.equal(rateLimit("k", limit, 62_000), 0, "window slides");
  assert.ok(LIMITS.login.max < LIMITS.transcribe.max, "login is stricter");
});

test("client IP comes from the first x-forwarded-for entry", () => {
  const req = new Request("https://x.test", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
  assert.equal(clientIp(req), "203.0.113.9");
  assert.equal(clientIp(new Request("https://x.test")), "unknown");
});

// ---- pricing -------------------------------------------------------------------------------------

test("pricing defaults, environment overrides and cost maths", async () => {
  await withEnv({ GEMINI_INPUT_USD_PER_MILLION: undefined, GEMINI_OUTPUT_USD_PER_MILLION: undefined }, () => {
    assert.deepEqual(getPricing(), { inputPerMillion: 2, outputPerMillion: 12, source: "default" });
    // 1M input at $2 + (400k output + 100k thinking) at $12 = 2 + 6
    assert.equal(costUsd({ inputTokens: 1_000_000, outputTokens: 400_000, thoughtTokens: 100_000 }), 8);
  });
  await withEnv({ GEMINI_INPUT_USD_PER_MILLION: "1.5", GEMINI_OUTPUT_USD_PER_MILLION: "" }, () => {
    assert.deepEqual(getPricing(), { inputPerMillion: 1.5, outputPerMillion: 12, source: "environment" });
  });
  await withEnv({ GEMINI_INPUT_USD_PER_MILLION: "not a number", GEMINI_OUTPUT_USD_PER_MILLION: "-3" }, () => {
    assert.equal(getPricing().source, "default", "invalid values are ignored");
  });
});

// ---- audio rules ---------------------------------------------------------------------------------

test("extension, MIME type and video detection", () => {
  assert.equal(extensionOf("talk.M4A"), "m4a");
  assert.equal(extensionOf("no-extension"), "");
  assert.equal(extensionOf("clip.m4a!"), "m4a", "only letters and digits are kept (safe for temp file names)");
  assert.equal(mimeTypeFor("a.mp3"), "audio/mpeg");
  assert.equal(mimeTypeFor("a.unknown", "audio/x-custom"), "audio/x-custom");
  assert.equal(mimeTypeFor("a.unknown"), "audio/mpeg");
  assert.equal(isVideo("clip.mp4"), true);
  assert.equal(isVideo("clip.bin", "video/quicktime"), true);
  assert.equal(isVideo("voice.mp3"), false);
});

test("what gets converted and split", () => {
  assert.equal(needsConversion("voice.mp3", 1_000_000), false, "small supported audio goes straight through");
  assert.equal(needsConversion("voice.mp3", MAX_UPLOAD_BYTES + 1), true, "too large for one request");
  assert.equal(needsConversion("clip.mp4", 1000), true, "video");
  assert.equal(needsConversion("voice.wma", 1000), true, "format Gemini does not read");
});

test("a 9-minute part always fits in one request", () => {
  const kbps = Number(CHUNK_BITRATE.replace("k", ""));
  const bytesPerPart = (CHUNK_SECONDS * kbps * 1000) / 8;
  // Allow 10% for MP3 framing and segment boundaries.
  assert.ok(bytesPerPart * 1.1 < MAX_UPLOAD_BYTES, `${bytesPerPart} bytes per part`);
  const args = conversionArgs("input.wav");
  assert.deepEqual(args.slice(args.indexOf("-f"), args.indexOf("-f") + 4), ["-f", "segment", "-segment_time", String(CHUNK_SECONDS)]);
  assert.equal(args.at(-1), "part%03d.mp3");
});

test("parts join in order without blank parts", () => {
  assert.equal(joinParts([" first ", "", "second"]), "first\n\nsecond");
});

test("rate-limit errors and retry hints from the provider", () => {
  assert.equal(isRateLimitError(new Error("429 RESOURCE_EXHAUSTED: quota exceeded")), true);
  assert.equal(isRateLimitError(new Error("invalid audio")), false);
  assert.equal(retrySecondsFrom("Please retry in 12.3s."), 13);
  assert.equal(retrySecondsFrom("busy", 30), 30);
});

test("the self-hosted FFmpeg path matches the pinned package version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["@ffmpeg/core"], FFMPEG_CORE_VERSION, "pin @ffmpeg/core exactly to FFMPEG_CORE_VERSION");
});
