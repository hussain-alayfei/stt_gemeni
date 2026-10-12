// Retry only temporary transcription failures. Every attempt is a separate
// request, and the caller records returned usage even for an empty response.
export type UsageData = {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};
export type TranscriptionResult = {
  transcript: string;
  usage?: UsageData;
};
type Payload = {
  transcript?: string;
  usage?: UsageData;
  error?: string;
  code?: string;
  retryAfter?: number;
};

export class TranscriptionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "TranscriptionError";
    this.status = status;
    this.code = code;
  }
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function transcribeChunk(
  audio: File,
  onAttempt: (description: string) => void,
  onUsage: (usage: UsageData) => void,
  send: typeof fetch = fetch,
  sleep: (milliseconds: number) => Promise<void> = wait,
): Promise<TranscriptionResult> {
  // Empty responses get one retry; HTTP 429/5xx get up to three attempts.
  let emptyAttempts = 0;
  let temporaryAttempts = 0;
  for (;;) {
    const form = new FormData();
    form.append("file", audio);
    let response: Response;
    let data: Payload = {};
    try {
      response = await send("/api/transcribe", { method: "POST", body: form });
      data = await response.json().catch(() => ({})) as Payload;
    } catch (cause) {
      if (temporaryAttempts >= 2) {
        throw new TranscriptionError("Network error. Retry this part to continue.", 0, "NETWORK_ERROR");
      }
      temporaryAttempts++;
      onAttempt(`Network retry ${temporaryAttempts}/2`);
      await sleep(temporaryAttempts * 1500);
      continue;
    }

    // A response can be billable even if transcription text is empty.
    if (data.usage) onUsage(data.usage);
    if (response.ok) {
      const transcript = (data.transcript || "").trim();
      if (!transcript) {
        data = { error: "No speech text returned.", code: "EMPTY_TRANSCRIPT" };
      } else {
        return { transcript };
      }
    }

    if (data.code === "EMPTY_TRANSCRIPT" && emptyAttempts < 1) {
      emptyAttempts++;
      onAttempt("Retrying empty result");
      await sleep(1200);
      continue;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && temporaryAttempts < 2) {
      temporaryAttempts++;
      const header = Number(response.headers.get("retry-after") || "0");
      const seconds = response.status === 429
        ? Math.min(120, Math.max(1, Number(data.retryAfter) || header || 30))
        : temporaryAttempts * 2;
      onAttempt(response.status === 429 ? `Rate limit · retry in ${Math.ceil(seconds)}s` : `Retrying request ${temporaryAttempts}/2`);
      await sleep(seconds * 1000);
      continue;
    }
    throw new TranscriptionError(
      data.code === "EMPTY_TRANSCRIPT"
        ? "No transcript was returned for this part after retrying. Click Transcribe again to retry only this part."
        : (data.error || `Request failed (${response.status}). Click Transcribe to resume.`),
      response.status,
      data.code || "REQUEST_FAILED",
    );
  }
}
