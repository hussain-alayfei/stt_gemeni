import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;
const INPUT_USD_PER_MILLION_TOKENS = 2;
const OUTPUT_USD_PER_MILLION_TOKENS = 12;

const MIME_BY_EXTENSION: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mpeg: "audio/mpeg",
  m4a: "audio/m4a",
  l16: "audio/l16",
  opus: "audio/opus",
  alaw: "audio/alaw",
  mulaw: "audio/mulaw",
  webm: "audio/webm",
};

function getExtension(name: string) {
  return name.split(".").pop()?.toLowerCase() || "mp3";
}

function getMimeType(file: File) {
  const ext = getExtension(file.name);
  if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  if (file.type?.startsWith("audio/")) return file.type;
  return "audio/mpeg";
}

function retrySecondsFromMessage(message: string) {
  const match = message.match(/retry in\s+([\d.]+)s/i);
  return match ? Math.ceil(Number(match[1])) : 35;
}

function isRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /429|quota exceeded|resource_exhausted/i.test(message);
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "Server configuration is incomplete." },
      { status: 500 },
    );
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

    if (file.size > MAX_BYTES) {
      return Response.json(
        { error: "Audio payload is too large for this request. The browser should compress it first." },
        { status: 413 },
      );
    }

    const extension = getExtension(file.name).replace(/[^a-z0-9]/g, "") || "mp3";
    const mimeType = getMimeType(file);
    tempPath = path.join(os.tmpdir(), `${randomUUID()}.${extension}`);

    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(tempPath, bytes);

    client = new GoogleGenAI({ apiKey });
    const audioFile = await client.files.upload({
      file: tempPath,
      config: { mimeType },
    });

    if (!audioFile.uri) {
      throw new Error("Audio upload did not return a usable file reference.");
    }

    uploadedName = audioFile.name || "";

    // Rate-limit and transient retries happen client-side, outside the Vercel
    // function deadline. Holding this function open for 30-40s is unsafe.
    const interaction = await client.interactions.create({
      model: "gemini-3.5-transcribe",
      input: [{
        type: "audio",
        uri: audioFile.uri,
        mime_type: audioFile.mimeType || mimeType,
      }],
      generation_config: {
        transcription_config: {
          mode: { type: "verbatim" },
        },
      },
    });

    const transcript = (interaction.output_text || "").trim();
    const inputTokens = interaction.usage?.total_input_tokens ?? 0;
    const outputTokens = interaction.usage?.total_output_tokens ?? 0;
    const thoughtTokens = interaction.usage?.total_thought_tokens ?? 0;
    const totalTokens = interaction.usage?.total_tokens ?? inputTokens + outputTokens + thoughtTokens;
    const costUsd =
      (inputTokens * INPUT_USD_PER_MILLION_TOKENS +
        (outputTokens + thoughtTokens) * OUTPUT_USD_PER_MILLION_TOKENS) /
      1_000_000;

    const usage = {
      inputTokens,
      outputTokens,
      thoughtTokens,
      totalTokens,
      costUsd: Number(costUsd.toFixed(8)),
    };

    if (!transcript) {
      // A valid model response can contain no text. Preserve billing usage and
      // tell the client that this particular segment needs a retry.
      console.warn("No transcript text returned", {
        status: interaction.status,
        inputTokens,
        outputTokens,
      });
      return Response.json({
        error: "No speech text was returned for this segment.",
        code: "EMPTY_TRANSCRIPT",
        usage,
      }, { status: 422 });
    }

    return Response.json({ transcript, usage });
  } catch (error) {
    console.error("Transcription error:", error);
    const message = error instanceof Error ? error.message : "Transcription failed.";
    const rateLimited = isRateLimitError(error);
    const retryAfter = rateLimited ? retrySecondsFromMessage(message) : undefined;

    return Response.json(
      {
        error: rateLimited
          ? "The service is busy. Please try again shortly."
          : "Transcription failed. Please try again.",
        retryAfter,
        code: rateLimited ? "RATE_LIMITED" : "UPSTREAM_ERROR",
      },
      {
        status: rateLimited ? 429 : 503,
        headers: rateLimited && retryAfter
          ? { "Retry-After": String(retryAfter) }
          : undefined,
      },
    );
  } finally {
    if (tempPath) {
      await unlink(tempPath).catch(() => undefined);
    }
    if (client && uploadedName) {
      await client.files.delete({ name: uploadedName }).catch(() => undefined);
    }
  }
}
