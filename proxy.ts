import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// First gate: pages without a valid session go to /login, APIs get 401. Every API route checks the
// session again itself (Next.js recommends never relying on Proxy alone for authorization).
export async function proxy(request: NextRequest) {
  if (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Please sign in." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const login = new URL("/login", request.url);
  if (request.nextUrl.pathname !== "/") login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except the login page and its API, Next.js assets, icons and the self-hosted FFmpeg files.
  matcher: ["/((?!login|api/login|_next/static|_next/image|ffmpeg/|favicon\\.ico|.*\\.svg$).*)"],
};
