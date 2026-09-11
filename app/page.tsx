"use client";

import { useEffect, useRef, useState } from "react";

const DIRECT_EXTENSIONS = new Set([
  "wav", "mp3", "aiff", "aif", "aac", "ogg", "flac", "mpeg",
  "m4a", "opus", "webm", "l16", "alaw", "mulaw",
]);

const MAX_SERVER_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT = 3;
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

function extensionOf(name: string) {
  const part = name.split(".").pop()?.toLowerCase();
  return part && part !== name.toLowerCase() ? part : "";
}

function humanSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function itemId(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`;
}

function needsConversion(file: File) {
  return !DIRECT_EXTENSIONS.has(extensionOf(file.name)) || file.size > MAX_SERVER_BYTES;
}

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

async function convertToMp3(file: File, onProgress: (value: number) => void) {
  const [{ FFmpeg }, { fetchFile, toBlobURL }] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
  ]);

  const ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => {
    onProgress(Math.max(0, Math.min(100, Math.round(progress * 100))));
  });

  const coreBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
  });

  const ext = extensionOf(file.name);
  const inputName = `input${ext ? `.${ext}` : ""}`;
  const outputName = "converted.mp3";

  await ffmpeg.writeFile(inputName, await fetchFile(file));
  await ffmpeg.exec([
    "-i", inputName,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    outputName,
  ]);

  const output = (await ffmpeg.readFile(outputName)) as Uint8Array;
  const converted = new File(
    [new Uint8Array(output)],
    `${file.name.replace(/\.[^.]+$/, "") || "audio"}.mp3`,
    { type: "audio/mpeg" },
  );

  try {
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outputName);
  } catch {}

  ffmpeg.terminate();
  return converted;
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
    }));

    setItems((current) => [...current, ...next]);
  }

  function removeItem(id: string) {
    if (processing) return;
    setItems((current) => current.filter((item) => item.id !== id));
  }

  async function processOne(item: AudioItem) {
    const { id, file } = item;
    updateItem(id, { error: "", transcript: "", copied: false, progress: 0 });

    try {
      let audio = file;

      if (needsConversion(file)) {
        updateItem(id, { stage: "converting", progress: 0 });
        audio = await convertToMp3(file, (progress) => updateItem(id, { progress }));
      }

      if (audio.size > MAX_SERVER_BYTES) {
        throw new Error("File is still too large after compression. Try a shorter recording.");
      }

      updateItem(id, { stage: "uploading" });

      const form = new FormData();
      form.append("file", audio);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: form,
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Transcription failed.");

      recordUsage(file.name, data.usage);
      updateItem(id, {
        transcript: data.transcript || "",
        stage: "done",
        progress: 100,
      });
    } catch (err) {
      updateItem(id, {
        stage: "error",
        error: err instanceof Error ? err.message : "Something went wrong.",
      });
    }
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
        <p>Upload files and transcribe them.</p>
      </section>

      <section className="workspace">
        <div className="leftPane">
          <section className="card">
            <input
              ref={inputRef}
              className="hiddenInput"
              type="file"
              multiple
              accept="audio/*,.amr,.3gp,.wma,.caf,.ape,.ac3,.mka"
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
              <strong>{items.length ? `${items.length} file${items.length === 1 ? "" : "s"}` : "Add audio"}</strong>
              <span className="dropHint">Drop files here or browse</span>
              <span className="formats">MP3 · WAV · M4A · OGG · FLAC · WEBM · more</span>
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
                      {item.stage === "converting" && <span>{item.progress}%</span>}
                      {item.stage === "uploading" && <span>Working</span>}
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
                  <div className="emptyProcessing"><WaveLoader /><span>Processing audio</span></div>
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

      <footer>3 files at a time</footer>
    </main>
  );
}
