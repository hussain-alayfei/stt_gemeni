"use client";

import { useMemo, useRef, useState } from "react";

const DIRECT_EXTENSIONS = new Set([
  "wav",
  "mp3",
  "aiff",
  "aif",
  "aac",
  "ogg",
  "flac",
  "mpeg",
  "m4a",
  "opus",
  "webm",
  "l16",
  "alaw",
  "mulaw",
]);

const MAX_SERVER_BYTES = 4 * 1024 * 1024;

type Stage = "idle" | "converting" | "uploading" | "done" | "error";

function extensionOf(name: string) {
  const part = name.split(".").pop()?.toLowerCase();
  return part && part !== name.toLowerCase() ? part : "";
}

function humanSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
    "-i",
    inputName,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "48k",
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
  } catch {
    // Cleanup failure should not block a successful conversion.
  }
  ffmpeg.terminate();
  return converted;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  const needsConversion = useMemo(() => {
    if (!file) return false;
    return !DIRECT_EXTENSIONS.has(extensionOf(file.name)) || file.size > MAX_SERVER_BYTES;
  }, [file]);

  function chooseFile(next: File | null) {
    if (!next) return;
    setFile(next);
    setTranscript("");
    setError("");
    setProgress(0);
    setStage("idle");
  }

  async function transcribe() {
    if (!file) return;

    setError("");
    setTranscript("");
    setCopied(false);

    try {
      let audio = file;
      if (needsConversion) {
        setStage("converting");
        setProgress(0);
        audio = await convertToMp3(file, setProgress);
      }

      if (audio.size > MAX_SERVER_BYTES) {
        throw new Error(
          "This recording is still too large after compression for the current Vercel upload path. Try a shorter clip for now.",
        );
      }

      setStage("uploading");
      const form = new FormData();
      form.append("file", audio);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: form,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Transcription failed.");
      }

      setTranscript(data.transcript || "");
      setStage("done");
    } catch (err) {
      setStage("error");
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function copyTranscript() {
    if (!transcript) return;
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  function downloadTranscript() {
    const blob = new Blob([transcript], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "transcript.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  const busy = stage === "converting" || stage === "uploading";

  return (
    <main className="shell">
      <section className="hero">
        <div className="eyebrow">GEMINI SPEECH TO TEXT</div>
        <h1>Speech in. Text out.</h1>
        <p>Fast transcription for Arabic, English, and mixed speech. No language selector needed.</p>
      </section>

      <section className="card">
        <input
          ref={inputRef}
          className="hiddenInput"
          type="file"
          accept="audio/*,.amr,.3gp,.wma,.caf,.ape,.ac3,.mka"
          onChange={(event) => chooseFile(event.target.files?.[0] || null)}
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
            chooseFile(event.dataTransfer.files?.[0] || null);
          }}
        >
          <span className="uploadIcon">↑</span>
          <strong>{file ? file.name : "Upload an audio file"}</strong>
          <span className="dropHint">
            {file ? `${humanSize(file.size)} · click to replace` : "Drop it here, or click to browse"}
          </span>
          <span className="formats">MP3 · WAV · M4A · OGG · FLAC · WEBM · AAC · OPUS · more</span>
        </button>

        {file && (
          <div className="fileNote">
            <span className="dot" />
            {needsConversion
              ? "This file will be converted to a compact MP3 in your browser before transcription."
              : "Gemini supports this format directly, so no conversion is needed."}
          </div>
        )}

        {stage === "converting" && (
          <div className="statusBlock">
            <div className="statusRow">
              <span>Preparing audio…</span>
              <span>{progress}%</span>
            </div>
            <div className="progressTrack">
              <div className="progressBar" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {stage === "uploading" && (
          <div className="statusBlock">
            <div className="statusRow">
              <span className="pulseText">Transcribing with Gemini…</span>
              <span>⚡</span>
            </div>
          </div>
        )}

        {error && <div className="errorBox">{error}</div>}

        <button className="primaryButton" type="button" disabled={!file || busy} onClick={transcribe}>
          {busy ? "Processing…" : "Transcribe"}
        </button>
      </section>

      {transcript && (
        <section className="resultCard">
          <div className="resultHeader">
            <div>
              <span className="resultLabel">TRANSCRIPT</span>
              <h2>Done</h2>
            </div>
            <div className="actions">
              <button type="button" onClick={copyTranscript}>{copied ? "Copied" : "Copy"}</button>
              <button type="button" onClick={downloadTranscript}>Download</button>
            </div>
          </div>
          <div className="transcript" dir="auto">{transcript}</div>
        </section>
      )}

      <footer>
        Powered by <strong>Gemini 3.5 Transcribe</strong> · API key stays server-side.
      </footer>
    </main>
  );
}
