export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "gemini-3.5-transcribe";
const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;

export async function GET() {
  const started = Date.now();
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return Response.json(
      { ok: false, status: "missing_key", latencyMs: Date.now() - started },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(MODEL_URL, {
      method: "GET",
      headers: { "x-goog-api-key": apiKey },
      cache: "no-store",
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;

    if (!response.ok) {
      return Response.json(
        {
          ok: false,
          status: "gemini_unavailable",
          upstreamStatus: response.status,
          latencyMs,
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      { ok: true, status: "connected", model: MODEL, latencyMs },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        status: error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error",
        latencyMs: Date.now() - started,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    clearTimeout(timeout);
  }
}
