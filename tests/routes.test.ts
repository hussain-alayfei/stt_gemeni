// Route handlers called directly with web Requests: sign-in, and that every API refuses visitors
// without a session. No Gemini calls are made (requests are refused before that point).
import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as login } from "../app/api/login/route";
import { POST as logout } from "../app/api/logout/route";
import { GET as config } from "../app/api/config/route";
import { GET as health } from "../app/api/health/route";
import { POST as transcribe } from "../app/api/transcribe/route";
import { resetRateLimits } from "../lib/rate-limit";
import { createSessionToken } from "../lib/session";

process.env.ACCESS_CODE = "route-test-code";

const loginRequest = (code: string, ip = "198.51.100.1") =>
  new Request("https://stt.test/api/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ code }),
  });

test("login: wrong code 401, right code sets a secure session cookie", async () => {
  resetRateLimits();
  const wrong = await login(loginRequest("nope"));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);

  const right = await login(loginRequest("route-test-code"));
  assert.equal(right.status, 200);
  const cookie = right.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^stt_session=v1\.\d+\.[\w-]+;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

test("login: too many attempts from one address are slowed down", async () => {
  resetRateLimits();
  let last: Response | undefined;
  for (let i = 0; i < 9; i++) last = await login(loginRequest("guess", "198.51.100.77"));
  assert.equal(last!.status, 429);
  assert.ok(Number(last!.headers.get("retry-after")) > 0);
});

test("login: without ACCESS_CODE the server explains what to set", async () => {
  const saved = process.env.ACCESS_CODE;
  delete process.env.ACCESS_CODE;
  try {
    const res = await login(loginRequest("anything"));
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /ACCESS_CODE/);
  } finally {
    process.env.ACCESS_CODE = saved;
  }
});

test("APIs refuse requests without a session", async () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(10)], "a.mp3", { type: "audio/mpeg" }));
  const responses = await Promise.all([
    transcribe(new Request("https://stt.test/api/transcribe", { method: "POST", body: form })),
    health(new Request("https://stt.test/api/health")),
    config(new Request("https://stt.test/api/config")),
  ]);
  for (const res of responses) assert.equal(res.status, 401);
});

test("APIs accept a valid session: config returns the pricing", async () => {
  const token = await createSessionToken();
  const res = await config(new Request("https://stt.test/api/config", { headers: { cookie: `stt_session=${token}` } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.pricing.inputPerMillion, "number");
});

test("transcribe with a session still validates the upload before calling Gemini", async () => {
  const token = await createSessionToken();
  const saved = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-not-used";
  try {
    const empty = new FormData();
    empty.append("file", new File([], "empty.mp3"));
    const res = await transcribe(
      new Request("https://stt.test/api/transcribe", { method: "POST", body: empty, headers: { cookie: `stt_session=${token}` } }),
    );
    assert.equal(res.status, 400);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test("logout clears the cookie", async () => {
  const res = await logout(new Request("https://stt.test/api/logout", { method: "POST" }));
  assert.match(res.headers.get("set-cookie") ?? "", /stt_session=; Path=\/; Max-Age=0/);
});
