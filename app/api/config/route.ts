import { getPricing } from "@/lib/pricing";
import { isSignedIn, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Settings the pages need: the token prices used for cost estimates. */
export async function GET(request: Request) {
  if (!(await isSignedIn(request))) return unauthorized();
  return Response.json({ pricing: getPricing() }, { headers: { "Cache-Control": "no-store" } });
}
