"use client";

import { useRef, useState } from "react";

const DIRECT_EXTENSIONS = new Set([
  "wav", "mp3", "aiff", "aif", "aac", "ogg", "flac", "mpeg",
  "m4a", "opus", "webm", "l16", "alaw", "mulaw",
]);

const MAX_SERVER_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT = 3;

type Stage = "idle" | "converting" | "uploading" | "done" | "error";

type AudioItem = {
  id: string;
  file: File;
  stage: Stage;
  progress: number;
  transcript: string;
  error: string;
  copied: boolean;
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

  const completedCount = items.filter((item) => item.stage === "done").length;

  return (
    <main className="shell">
      <section className="hero">
        <div className="eyebrow">GEMINI SPEECH TO TEXT</div>
        <h1>Speech in. Text out.</h1>
        <p>Upload multiple recordings and transcribe Arabic, English, or mixed speech in parallel.</p>
      </section>

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
          <span className="uploadIcon">↑</span>
          <strong>{items.length ? `${items.length} audio file${items.length === 1 ? "" : "s"} selected` : "Upload audio files"}</strong>
          <span className="dropHint">Drop multiple files here, or click to browse</span>
          <span className="formats">MP3 · WAV · M4A · OGG · FLAC · WEBM · AAC · OPUS · more</span>
        </button>

        {items.length > 0 && (
          <div className="queueList">
            {items.map((item) => (
              <div className="queueItem" key={item.id}>
                <div className="queueMain">
                  <strong>{item.file.name}</strong>
                  <span>{humanSize(item.file.size)}</span>
                </div>

                <div className="queueStatus">
                  {item.stage === "idle" && <span>Ready</span>}
                  {item.stage === "converting" && <span>Converting {item.progress}%</span>}
                  {item.stage === "uploading" && <span className="pulseText">Transcribing…</span>}
                  {item.stage === "done" && <span className="successText">Done</span>}
                  {item.stage === "error" && <span className="errorText">Failed</span>}
                  {!processing && <button type="button" className="removeButton" onClick={() => removeItem(item.id)}>×</button>}
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
          {processing ? `Processing ${items.length} files…` : `Transcribe ${items.length || ""}${items.length === 1 ? " file" : items.length > 1 ? " files" : ""}`}
        </button>
      </section>

      {completedCount > 0 && (
        <section className="batchHeader">
          <div>
            <span className="resultLabel">RESULTS</span>
            <h2>{completedCount} of {items.length} complete</h2>
          </div>
          <button type="button" className="downloadAllButton" onClick={downloadAll}>Download all</button>
        </section>
      )}

      {items.filter((item) => item.transcript).map((item) => (
        <section className="resultCard" key={`result-${item.id}`}>
          <div className="resultHeader">
            <div>
              <span className="resultLabel">TRANSCRIPT</span>
              <h2>{item.file.name}</h2>
            </div>
            <div className="actions">
              <button type="button" onClick={() => copyTranscript(item)}>{item.copied ? "Copied" : "Copy"}</button>
              <button type="button" onClick={() => downloadTranscript(item)}>Download</button>
            </div>
          </div>
          <div className="transcript" dir="auto">{item.transcript}</div>
        </section>
      ))}

      <footer>
        Up to <strong>{MAX_CONCURRENT} recordings process in parallel</strong> · Powered by Gemini 3.5 Transcribe.
      </footer>
    </main>
  );
}
