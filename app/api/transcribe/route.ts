import { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;

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

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "GEMINI_API_KEY is missing from the server environment." },
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
        { error: "Audio payload is too large for this Vercel function. The browser should compress it first." },
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
      throw new Error("Gemini did not return a URI for the uploaded audio file.");
    }

    uploadedName = audioFile.name || "";

    const interaction = await client.interactions.create({
      model: "gemini-3.5-transcribe",
      input: [
        {
          type: "audio",
          uri: audioFile.uri,
          mime_type: audioFile.mimeType || mimeType,
        },
      ],
      generation_config: {
        transcription_config: {
          mode: { type: "verbatim" },
        },
      },
    });

    const transcript = (interaction.output_text || "").trim();
    if (!transcript) {
      throw new Error("Gemini returned an empty transcript.");
    }

    return Response.json({ transcript });
  } catch (error) {
    console.error("Transcription error:", error);
    const message = error instanceof Error ? error.message : "Transcription failed.";
    const isRateLimited = /429|quota exceeded|resource_exhausted/i.test(message);

    return Response.json(
      {
        error: isRateLimited ? "Gemini rate limit reached. Retrying shortly…" : message,
        retryAfter: isRateLimited ? retrySecondsFromMessage(message) : undefined,
      },
      {
        status: isRateLimited ? 429 : 500,
        headers: isRateLimited
          ? { "Retry-After": String(retrySecondsFromMessage(message)) }
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
