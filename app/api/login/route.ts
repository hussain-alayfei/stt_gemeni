import { LIMITS, clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { accessCodeConfigured, checkAccessCode, createSessionToken, sessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  if (!accessCodeConfigured()) {
    return Response.json(
      { error: "Sign-in is not set up yet: add ACCESS_CODE to the server's environment variables and redeploy." },
      { status: 503, headers: NO_STORE },
    );
  }

  const wait = rateLimit(`login:${clientIp(request)}`, LIMITS.login);
  if (wait) return tooManyRequests(wait, `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`);

  let code = "";
  try {
    const body = await request.json();
    code = typeof body?.code === "string" ? body.code : "";
  } catch {
    // Treated as an empty code below.
  }

  if (!(await checkAccessCode(code))) {
    // A short pause makes guessing slower without bothering a real user.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return Response.json({ error: "That access code is not correct." }, { status: 401, headers: NO_STORE });
  }

  const token = await createSessionToken();
  const secure = new URL(request.url).protocol === "https:";
  return Response.json({ ok: true }, { headers: { ...NO_STORE, "Set-Cookie": sessionCookie(token!, secure) } });
}
