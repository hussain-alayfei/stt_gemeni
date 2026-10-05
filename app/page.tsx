"use client";

import { useEffect, useRef, useState } from "react";
import { FFMPEG_BASE, MAX_UPLOAD_BYTES, conversionArgs, extensionOf, isVideo, joinParts, needsConversion as needsConversionFor } from "@/lib/audio";

const MAX_CONCURRENT = 3;
const MAX_ATTEMPTS = 4;
const MAX_WAIT_SECONDS = 60;
const THEME_KEY = "stt-theme";
const USAGE_KEY = "stt-usage-v1";

type Stage = "idle" | "converting" | "uploading" | "done" | "error";
type ThemeMode = "light" | "dark" | "system";
type HealthState = "checking" | "connected" | "error";

type AudioItem = {
  id: string;
  file: File;
  stage: Stage;
  progress: number;
  transcript: string;
  error: string;
  copied: boolean;
  /** 1-based part being transcribed and the number of parts (long recordings are split). */
  part: number;
  parts: number;
  /** Short status note, e.g. while waiting for a busy service. */
  note: string;
};

type HealthInfo = {
  state: HealthState;
  latencyMs?: number;
};

type UsagePayload = {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

type UsageEntry = {
  id: string;
  createdAt: string;
  fileName: string;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  costUsd: number;
};

function humanSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function itemId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`;
}

function isVideoFile(file: File) {
  return isVideo(file.name, file.type);
}

function needsConversion(file: File) {
  return needsConversionFor(file.name, file.size, file.type);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class SignedOutError extends Error {}

function applyTheme(mode: ThemeMode) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function WaveLoader() {
  return (
    <span className="waveLoader" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, index) => (
        <span key={index} style={{ animationDelay: `${index * 90}ms` }} />
      ))}
    </span>
  );
}

function recordUsage(fileName: string, usage?: UsagePayload) {
  if (!usage) return;

  const entry: UsageEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    fileName,
    inputTokens: Number(usage.inputTokens) || 0,
    outputTokens: Number(usage.outputTokens) || 0,
    thoughtTokens: Number(usage.thoughtTokens) || 0,
    totalTokens: Number(usage.totalTokens) || 0,
    costUsd: Number(usage.costUsd) || 0,
  };

  try {
    const stored = localStorage.getItem(USAGE_KEY);
    const current = stored ? JSON.parse(stored) : [];
    const entries = Array.isArray(current) ? current : [];
    localStorage.setItem(USAGE_KEY, JSON.stringify([...entries, entry].slice(-1000)));
    window.dispatchEvent(new Event("stt-usage-updated"));
  } catch {
    // Usage tracking must never block transcription.
  }
}

/** Converts any media to mono 16 kHz MP3 and splits it into parts small enough for one request. */
async function convertToParts(file: File, onProgress: (value: number) => void): Promise<File[]> {
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
  ]);

  const ffmpeg = new FFmpeg();
  let inputName = "";
  let partNames: string[] = [];

  try {
    ffmpeg.on("progress", ({ progress }) => {
      onProgress(Math.max(0, Math.min(100, Math.round(progress * 100))));
    });

    await ffmpeg.load({
      coreURL: await toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${FFMPEG_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });

    const ext = extensionOf(file.name);
    inputName = `input${ext ? `.${ext}` : ""}`;
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    const exitCode = await ffmpeg.exec(conversionArgs(inputName));
    partNames = (await ffmpeg.listDir("/"))
      .map((entry) => entry.name)
      .filter((name) => /^part\d{3}\.mp3$/.test(name))
      .sort();

    if (exitCode !== 0 || !partNames.length) {
      throw new Error(
        isVideoFile(file)
          ? "Could not extract audio from this video. Make sure it contains an audio track."
          : "Could not convert this media file to audio.",
      );
    }

    const base = file.name.replace(/\.[^.]+$/, "") || "audio";
    const parts: File[] = [];
    for (const [index, name] of partNames.entries()) {
      const output = (await ffmpeg.readFile(name)) as Uint8Array;
      if (output.length) parts.push(new File([new Uint8Array(output)], `${base}-part${index + 1}.mp3`, { type: "audio/mpeg" }));
    }
    if (!parts.length) throw new Error("The converted audio is empty.");
    return parts;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(isVideoFile(file) ? "Could not extract audio from this video." : "Could not convert this media file.");
  } finally {
    for (const name of [inputName, ...partNames]) {
      if (name) await ffmpeg.deleteFile(name).catch(() => undefined);
    }
    ffmpeg.terminate();
  }
}

type PartResult = { transcript: string; usage?: UsagePayload };

/**
 * Sends one part to the server. A busy service (429) is retried here in the browser after the
 * wait it asks for, so no server function stays open while waiting.
 */
async function transcribePart(audio: File, onWait: (seconds: number) => void): Promise<PartResult> {
  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.append("file", audio);
    const response = await fetch("/api/transcribe", { method: "POST", body: form });
    if (response.status === 401) throw new SignedOutError("Your session has ended. Please sign in again.");
    const data = await response.json().catch(() => ({}));
    if (response.ok) return { transcript: data.transcript || "", usage: data.usage };

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) throw new Error(data.error || "Transcription failed.");
    const waitSeconds = response.status === 429
      ? Math.min(Number(data.retryAfter) || Number(response.headers.get("Retry-After")) || 15, MAX_WAIT_SECONDS)
      : 3 * attempt;
    onWait(waitSeconds);
    await sleep(waitSeconds * 1000);
  }
}

function sumUsage(parts: (UsagePayload | undefined)[]): UsagePayload {
  const total = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0, costUsd: 0 };
  for (const usage of parts) {
    if (!usage) continue;
    total.inputTokens += Number(usage.inputTokens) || 0;
    total.outputTokens += Number(usage.outputTokens) || 0;
    total.thoughtTokens += Number(usage.thoughtTokens) || 0;
    total.totalTokens += Number(usage.totalTokens) || 0;
    total.costUsd += Number(usage.costUsd) || 0;
  }
  return total;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<AudioItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [health, setHealth] = useState<HealthInfo>({ state: "checking" });

  useEffect(() => {
    const saved = localStorage.getItem(THEME_KEY);
    const initial: ThemeMode = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    setTheme(initial);
    applyTheme(initial);
  }, []);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem(THEME_KEY, theme);

    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [theme]);

  useEffect(() => {
    let active = true;

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        const data = await response.json();
        if (!active) return;
        setHealth({
          state: response.ok && data.ok ? "connected" : "error",
          latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : undefined,
        });
      } catch {
        if (active) setHealth({ state: "error" });
      }
    }

    checkHealth();
    const timer = window.setInterval(checkHealth, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  function updateItem(id: string, patch: Partial<AudioItem>) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList);
    if (!incoming.length) return;

    const next = incoming.map((file) => ({
      id: itemId(file),
      file,
      stage: "idle" as Stage,
      progress: 0,
      transcript: "",
      error: "",
      copied: false,
      part: 0,
      parts: 0,
      note: "",
    }));

    setItems((current) => [...current, ...next]);
  }

  function removeItem(id: string) {
    if (processing) return;
    setItems((current) => current.filter((item) => item.id !== id));
  }

  async function processOne(item: AudioItem) {
    const { id, file } = item;
    updateItem(id, { error: "", transcript: "", copied: false, progress: 0, part: 0, parts: 0, note: "" });

    try {
      let parts = [file];
      if (needsConversion(file)) {
        updateItem(id, { stage: "converting", progress: 0 });
        parts = await convertToParts(file, (progress) => updateItem(id, { progress }));
      }
      if (parts.some((part) => part.size > MAX_UPLOAD_BYTES)) {
        throw new Error("A part is still too large after compression. Please try another file.");
      }

      const results: PartResult[] = [];
      for (const [index, part] of parts.entries()) {
        updateItem(id, { stage: "uploading", part: index + 1, parts: parts.length, note: "" });
        results.push(
          await transcribePart(part, (seconds) => updateItem(id, { note: `Service busy, retrying in ${seconds}s` })),
        );
      }

      recordUsage(file.name, sumUsage(results.map((result) => result.usage)));
      updateItem(id, {
        transcript: joinParts(results.map((result) => result.transcript)),
        stage: "done",
        progress: 100,
        note: "",
      });
    } catch (err) {
      if (err instanceof SignedOutError) {
        window.location.assign("/login");
        return;
      }
      updateItem(id, {
        stage: "error",
        note: "",
        error: err instanceof Error ? err.message : "Could not process this file.",
      });
    }
  }

  async function signOut() {
    await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }

  async function transcribeAll() {
    if (!items.length || processing) return;
    setProcessing(true);

    const queue = [...items];
    let cursor = 0;

    async function worker() {
      while (true) {
        const index = cursor++;
        if (index >= queue.length) return;
        await processOne(queue[index]);
      }
    }

    const workerCount = Math.min(MAX_CONCURRENT, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    setProcessing(false);
  }

  async function copyTranscript(item: AudioItem) {
    if (!item.transcript) return;
    await navigator.clipboard.writeText(item.transcript);
    updateItem(item.id, { copied: true });
    window.setTimeout(() => updateItem(item.id, { copied: false }), 1400);
  }

  function downloadTranscript(item: AudioItem) {
    const blob = new Blob([item.transcript], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${item.file.name.replace(/\.[^.]+$/, "") || "transcript"}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function downloadAll() {
    const completed = items.filter((item) => item.transcript);
    if (!completed.length) return;

    const combined = completed
      .map((item) => `===== ${item.file.name} =====\n\n${item.transcript}`)
      .join("\n\n\n");

    const blob = new Blob([combined], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "all-transcripts.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  const completedItems = items.filter((item) => item.transcript);
  const completedCount = completedItems.length;
  const healthLabel = health.state === "connected"
    ? `API connected${health.latencyMs ? ` · ${health.latencyMs} ms` : ""}`
    : health.state === "checking"
      ? "Checking API"
      : "API unavailable";

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brandArea">
          <div className="brand">Speech to Text</div>
          <div className={`healthStatus ${health.state}`} title="Backend API connection">
            <span className="statusDot" />
            <span>{healthLabel}</span>
          </div>
        </div>

        <div className="topbarActions">
          <nav className="pageNav" aria-label="Pages">
            <a className="navLink active" href="/">Transcribe</a>
            <a className="navLink" href="/usage">Usage</a>
          </nav>
          <button type="button" className="signOutButton" onClick={signOut}>Sign out</button>
          <div className="themeSwitch" role="group" aria-label="Color theme">
            {(["light", "dark", "system"] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={theme === mode ? "active" : ""}
                aria-pressed={theme === mode}
                onClick={() => setTheme(mode)}
              >
                {mode[0].toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <section className="intro">
        <h1>Audio to text</h1>
        <p>Upload audio or video and transcribe it.</p>
      </section>

      <section className="workspace">
        <div className="leftPane">
          <section className="card">
            <input
              ref={inputRef}
              className="hiddenInput"
              type="file"
              multiple
              accept="audio/*,video/mp4,video/quicktime,video/x-m4v,.mp4,.mov,.m4v,.mkv,.avi,.3gp,.amr,.wma,.caf,.ape,.ac3,.mka"
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = "";
              }}
            />

            <button
              type="button"
              className={`dropzone ${dragging ? "dragging" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                addFiles(event.dataTransfer.files);
              }}
            >
              <span className="uploadIcon">+</span>
              <strong>{items.length ? `${items.length} file${items.length === 1 ? "" : "s"}` : "Add media"}</strong>
              <span className="dropHint">Drop files here or browse</span>
              <span className="formats">MP3 · WAV · M4A · MP4 · MOV · OGG · FLAC · WEBM · more</span>
            </button>

            {items.length > 0 && (
              <div className="queueList">
                {items.map((item) => (
                  <div className="queueItem fadeItem" key={item.id}>
                    <div className="queueMain">
                      <strong>{item.file.name}</strong>
                      <span>{humanSize(item.file.size)}</span>
                    </div>

                    <div className="queueStatus">
                      {item.stage === "idle" && <span>Ready</span>}
                      {item.stage === "converting" && <span>{isVideoFile(item.file) ? `Extracting audio · ${item.progress}%` : `${item.progress}%`}</span>}
                      {item.stage === "uploading" && (
                        <span className="partStatus">
                          {item.note || (item.parts > 1 ? `Part ${item.part} of ${item.parts}` : "Working")}
                        </span>
                      )}
                      {item.stage === "done" && <span className="successText">Done</span>}
                      {item.stage === "error" && <span className="errorText">Failed</span>}
                      {!processing && <button type="button" className="removeButton" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.file.name}`}>×</button>}
                    </div>

                    {item.stage === "converting" && (
                      <div className="progressTrack queueProgress">
                        <div className="progressBar" style={{ width: `${item.progress}%` }} />
                      </div>
                    )}

                    {item.error && <div className="queueError">{item.error}</div>}
                  </div>
                ))}
              </div>
            )}

            <button className="primaryButton" type="button" disabled={!items.length || processing} onClick={transcribeAll}>
              {processing ? "Transcribing" : items.length ? `Transcribe ${items.length}` : "Transcribe"}
            </button>
          </section>
        </div>

        <div className="rightPane">
          <section className="resultsPanel">
            <div className="batchHeader">
              <div>
                <span className="resultLabel">Results</span>
                <h2>{completedCount ? `${completedCount} of ${items.length} complete` : "Transcripts"}</h2>
              </div>
              {completedCount > 0 && (
                <button type="button" className="downloadAllButton" onClick={downloadAll}>Download all</button>
              )}
            </div>

            {!completedCount && (
              <div className="emptyState">
                {processing ? (
                  <div className="emptyProcessing"><WaveLoader /><span>Processing media</span></div>
                ) : "Transcripts appear here."}
              </div>
            )}

            <div className="resultsList">
              {completedItems.map((item) => (
                <section className="resultCard fadeItem" key={`result-${item.id}`}>
                  <div className="resultHeader">
                    <h2>{item.file.name}</h2>
                    <div className="actions">
                      <button type="button" onClick={() => copyTranscript(item)}>{item.copied ? "Copied" : "Copy"}</button>
                      <button type="button" onClick={() => downloadTranscript(item)}>Download</button>
                    </div>
                  </div>
                  <div className="transcript" dir="auto">{item.transcript}</div>
                </section>
              ))}
            </div>
          </section>
        </div>
      </section>

      <footer>3 files at a time · video audio is extracted automatically · long recordings are split into 9-minute parts</footer>
    </main>
  );
}