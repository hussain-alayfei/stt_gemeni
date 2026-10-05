import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_UPLOAD_BYTES, extensionOf, isRateLimitError, mimeTypeFor, retrySecondsFrom } from "@/lib/audio";
import { costUsd, getPricing } from "@/lib/pricing";
import { LIMITS, clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { isSignedIn, unauthorized } from "@/lib/session";

export const runtime = "nodejs";
// One request carries one part of at most 9 minutes of audio, so this is plenty.
export const maxDuration = 120;

const MODEL = "gemini-3.5-transcribe";
// Wait inside the request only for short provider back-offs; longer ones go back to the browser,
// which retries without holding a server function open.
const MAX_INLINE_RETRY_SECONDS = 10;

export async function POST(request: Request) {
  if (!(await isSignedIn(request))) return unauthorized();

  const wait = rateLimit(`transcribe:${clientIp(request)}`, LIMITS.transcribe);
  if (wait) return tooManyRequests(wait, "Too many requests at once. Retrying shortly.");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "Server configuration is incomplete." }, { status: 500 });
  }

  let tempPath = "";
  let uploadedName = "";
  let client: GoogleGenAI | null = null;

  try {
    const formData = await request.formData();
    const entry = formData.get("file");

    if (!entry || typeof entry === "string") {
      return Response.json({ error: "No audio file was uploaded." }, { status: 400 });
    }

    const file = entry as File;
    if (file.size === 0) {
      return Response.json({ error: "The uploaded audio file is empty." }, { status: 400 });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: "Audio part is too large for one request. The browser should split it first." },
        { status: 413 },
      );
    }

    const extension = extensionOf(file.name) || "mp3";
    const mimeType = mimeTypeFor(file.name, file.type);
    tempPath = path.join(os.tmpdir(), `${randomUUID()}.${extension}`);
    await writeFile(tempPath, Buffer.from(await file.arrayBuffer()));

    client = new GoogleGenAI({ apiKey });
    const audioFile = await client.files.upload({ file: tempPath, config: { mimeType } });
    if (!audioFile.uri) throw new Error("Audio upload did not return a usable file reference.");
    uploadedName = audioFile.name || "";

    const transcribe = () =>
      client!.interactions.create({
        model: MODEL,
        input: [{ type: "audio", uri: audioFile.uri!, mime_type: audioFile.mimeType || mimeType }],
        generation_config: { transcription_config: { mode: { type: "verbatim" } } },
      });

    let interaction;
    try {
      interaction = await transcribe();
    } catch (firstError) {
      if (!isRateLimitError(firstError)) throw firstError;
      const retrySeconds = retrySecondsFrom(firstError instanceof Error ? firstError.message : String(firstError));
      if (retrySeconds > MAX_INLINE_RETRY_SECONDS) throw firstError;
      await new Promise((resolve) => setTimeout(resolve, (retrySeconds + 1) * 1000));
      interaction = await transcribe();
    }

    const transcript = (interaction.output_text || "").trim();
    if (!transcript) throw new Error("Transcription returned an empty result.");

    const inputTokens = interaction.usage?.total_input_tokens ?? 0;
    const outputTokens = interaction.usage?.total_output_tokens ?? 0;
    const thoughtTokens = interaction.usage?.total_thought_tokens ?? 0;
    const totalTokens = interaction.usage?.total_tokens ?? inputTokens + outputTokens + thoughtTokens;
    const pricing = getPricing();

    return Response.json({
      transcript,
      usage: {
        inputTokens,
        outputTokens,
        thoughtTokens,
        totalTokens,
        costUsd: costUsd({ inputTokens, outputTokens, thoughtTokens }, pricing),
      },
      pricing,
    });
  } catch (error) {
    console.error("Transcription error:", error);
    const message = error instanceof Error ? error.message : "Transcription failed.";
    const rateLimited = isRateLimitError(error);
    const retryAfter = rateLimited ? retrySecondsFrom(message) : undefined;

    return Response.json(
      {
        error: rateLimited ? "The service is busy. Retrying shortly." : "Transcription failed. Please try again.",
        retryAfter,
      },
      {
        status: rateLimited ? 429 : 500,
        headers: rateLimited && retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
      },
    );
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => undefined);
    if (client && uploadedName) await client.files.delete({ name: uploadedName }).catch(() => undefined);
  }
}
