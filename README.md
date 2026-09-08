# Gemini Speech to Text

A minimal web app for fast speech-to-text transcription using Google's dedicated **Gemini 3.5 Transcribe** model.

## What it does

- Upload audio with drag & drop
- Works directly with Gemini-supported formats including MP3, WAV, M4A, OGG, FLAC, AAC, OPUS, WEBM, AIFF and more
- Automatically converts unsupported formats to a compact MP3 in the browser using FFmpeg.wasm
- Automatically compresses oversized uploads before sending them to the Vercel API route
- Auto-detects Arabic, English and mixed/code-switched speech
- Uses verbatim transcription to preserve spoken wording and dialect
- Copy or download the transcript
- Keeps the Gemini API key server-side

## Stack

- Next.js 16
- React 19
- TypeScript
- `@google/genai`
- `gemini-3.5-transcribe`
- FFmpeg.wasm for browser-side audio conversion
- Vercel

## Run locally

```bash
git clone https://github.com/hussain-alayfei/stt_gemeni.git
cd stt_gemeni
npm install
```

Create `.env.local`:

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
```

Then run:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Deploy to Vercel

1. Import this GitHub repository into Vercel.
2. Go to **Project Settings → Environment Variables**.
3. Add:

```text
GEMINI_API_KEY = your_google_ai_studio_key
```

4. Redeploy.

The API key is only read inside `app/api/transcribe/route.ts`; it is never exposed to the browser.

## Audio handling

Gemini 3.5 Transcribe natively supports common speech formats, so supported files are sent without conversion for the lowest latency. If the file format is not supported, the browser converts it to mono 16 kHz MP3 before upload.

Because Vercel Functions have a request payload limit, large files are also compressed in the browser. Extremely long recordings that remain above the request limit after compression will currently show a clear size error instead of failing silently.

## Model

This project uses:

```text
gemini-3.5-transcribe
```

The model automatically identifies the spoken language and supports multilingual/code-switched audio. The app intentionally uses **verbatim** mode to preserve fillers, repetitions and dialect wording as closely as possible.
