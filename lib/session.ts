// Access-code login with a signed session cookie. Uses Web Crypto only, so the same code runs in
// proxy.ts and in route handlers. The signing key is derived from ACCESS_CODE: changing the code
// signs everyone out.

export const SESSION_COOKIE = "stt_session";
export const SESSION_DAYS = 30;
const VERSION = "v1";
const encoder = new TextEncoder();

export function accessCodeConfigured(): boolean {
  return Boolean(process.env.ACCESS_CODE?.trim());
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signingKey(): Promise<CryptoKey | null> {
  const code = process.env.ACCESS_CODE?.trim();
  if (!code) return null;
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`stt-session-${VERSION}:${code}`));
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Token "v1.<expiry seconds>.<signature>"; undefined when no access code is configured. */
export async function createSessionToken(now = Date.now()): Promise<string | undefined> {
  const key = await signingKey();
  if (!key) return undefined;
  const payload = `${VERSION}.${Math.floor(now / 1000) + SESSION_DAYS * 86400}`;
  return `${payload}.${base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)))}`;
}

export async function verifySessionToken(token: string | undefined | null, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [version, expiry, signature] = token.split(".");
  if (version !== VERSION || !/^\d+$/.test(expiry ?? "") || !signature) return false;
  if (Number(expiry) * 1000 <= now) return false;
  const key = await signingKey();
  const bytes = fromBase64url(signature);
  if (!key || !bytes) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, bytes, encoder.encode(`${version}.${expiry}`));
}

/** Constant-time check of a typed access code (compares SHA-256 digests, so lengths never leak). */
export async function checkAccessCode(input: string): Promise<boolean> {
  const expected = process.env.ACCESS_CODE?.trim();
  if (!expected || !input) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(input.trim())),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function readCookie(header: string | null, name = SESSION_COOKIE): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** True when the request carries a valid session cookie. Route handlers must call this themselves. */
export async function isSignedIn(request: Request): Promise<boolean> {
  return verifySessionToken(readCookie(request.headers.get("cookie")));
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export function unauthorized(): Response {
  return Response.json({ error: "Please sign in." }, { status: 401, headers: { "Cache-Control": "no-store" } });
}
