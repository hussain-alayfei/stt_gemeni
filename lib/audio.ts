// Shared audio rules for the browser (what to convert, how to split) and the server (MIME types).

/** Must equal the exact @ffmpeg/core version in package.json (checked by a test). */
export const FFMPEG_CORE_VERSION = "0.12.10";
/** Where scripts/copy-ffmpeg.mjs puts the core, served by this site. */
export const FFMPEG_BASE = `/ffmpeg/${FFMPEG_CORE_VERSION}`;

/** Vercel Functions accept request bodies up to 4.5 MB; stay below it. */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Long recordings are split into parts of this length. At 48 kbps a 9-minute part is about 3.2 MB. */
export const CHUNK_SECONDS = 9 * 60;
export const CHUNK_BITRATE = "48k";

export const MIME_BY_EXTENSION: Record<string, string> = {
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

export const DIRECT_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));
export const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "mkv", "avi", "3gp"]);

export function extensionOf(name: string): string {
  const part = name.split(".").pop()?.toLowerCase();
  return part && part !== name.toLowerCase() ? part.replace(/[^a-z0-9]/g, "") : "";
}

export function mimeTypeFor(name: string, declaredType?: string): string {
  const ext = extensionOf(name);
  if (MIME_BY_EXTENSION[ext]) return MIME_BY_EXTENSION[ext];
  if (declaredType?.startsWith("audio/")) return declaredType;
  return "audio/mpeg";
}

export function isVideo(name: string, declaredType = ""): boolean {
  return declaredType.startsWith("video/") || VIDEO_EXTENSIONS.has(extensionOf(name));
}

/** Video, formats Gemini does not read directly, and anything too large for one request are converted first. */
export function needsConversion(name: string, size: number, declaredType = ""): boolean {
  return isVideo(name, declaredType) || !DIRECT_EXTENSIONS.has(extensionOf(name)) || size > MAX_UPLOAD_BYTES;
}

/** FFmpeg arguments: mono 16 kHz MP3, split into CHUNK_SECONDS parts named part000.mp3, part001.mp3, … */
export function conversionArgs(inputName: string): string[] {
  return [
    "-i", inputName,
    "-map", "0:a:0",
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", CHUNK_BITRATE,
    "-f", "segment",
    "-segment_time", String(CHUNK_SECONDS),
    "-reset_timestamps", "1",
    "part%03d.mp3",
  ];
}

/** Joins the transcripts of consecutive parts of one recording. */
export function joinParts(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join("\n\n");
}

export function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|quota exceeded|resource_exhausted/i.test(message);
}

/** Seconds from a provider message such as "Please retry in 12.3s", or the fallback. */
export function retrySecondsFrom(message: string, fallback = 30): number {
  const match = message.match(/retry in\s+([\d.]+)s/i);
  return match ? Math.max(1, Math.ceil(Number(match[1]))) : fallback;
}
