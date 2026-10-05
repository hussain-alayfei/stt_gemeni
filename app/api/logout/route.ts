import { clearedSessionCookie } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store", "Set-Cookie": clearedSessionCookie(secure) } });
}
