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
- Long recordings of any length: split in the browser into 9-minute parts, transcribed in order and joined
- Sign-in with an access code, so only you can spend your Gemini credits
- Keeps the Gemini API key server-side
- Usage page with token counts and cost per file

## Stack

- Next.js 16
- React 19
- TypeScript
- `@google/genai`
- `gemini-3.5-transcribe`
- FFmpeg.wasm for browser-side audio conversion (self-hosted, no CDN)
- Vercel
- Tests: `node:test` + `tsx`

## Run locally

```bash
git clone https://github.com/hussain-alayfei/stt_gemeni.git
cd stt_gemeni
npm install
```

Create `.env.local`:

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
ACCESS_CODE=choose_a_long_random_code
```

Then run:

```bash
npm run dev
```

Open `http://localhost:3000` and sign in with your `ACCESS_CODE`.

Checks:

```bash
npm run typecheck
npm test              # session, rate limits, pricing, audio rules, API routes
npm run check:split   # runs the real FFmpeg core on a 20-minute recording
```

## Deploy to Vercel

1. Import this GitHub repository into Vercel.
2. Go to **Project Settings → Environment Variables**.
3. Add:

```text
GEMINI_API_KEY = your_google_ai_studio_key   (Sensitive)
ACCESS_CODE    = a long random code           (Sensitive)
```

Optional: `GEMINI_INPUT_USD_PER_MILLION` and `GEMINI_OUTPUT_USD_PER_MILLION` if Google changes its prices (defaults 2 and 12).

4. Redeploy.

The API key is only read on the server; it is never exposed to the browser.

## Security

- **Sign-in:** every page and API needs a session. The session is a signed, HttpOnly cookie that lasts 30 days. `proxy.ts` redirects signed-out visitors to `/login`, and every API route checks the session again itself. Changing `ACCESS_CODE` signs everyone out.
- **Limits:** 8 sign-in attempts per 10 minutes and 40 transcriptions per minute per address, per server instance. For a hard spending cap, also set a budget in Google AI Studio / Google Cloud billing.
- **Headers:** `nosniff`, no framing, no `X-Powered-By`.

## Audio handling

Gemini 3.5 Transcribe natively supports common speech formats, so supported files are sent without conversion for the lowest latency. If the file format is not supported, the browser converts it to mono 16 kHz MP3 before upload.

Vercel Functions accept at most 4.5 MB per request, so files that are too large, videos and unsupported formats are converted in the browser to mono 16 kHz MP3 at 48 kbps and **split into 9-minute parts** (about 3.1 MB each). The parts are transcribed one after another and joined, so a recording of any length works. A word that falls exactly on a part boundary can be split between two parts.

If the service is busy (HTTP 429), the browser waits as long as Google asks and retries (up to 4 attempts), so no server function is kept waiting.

FFmpeg's WebAssembly core is copied from `node_modules` into `public/ffmpeg/<version>/` at build time (`scripts/copy-ffmpeg.mjs`) and served from this site with long-term caching.

## Model

This project uses:

```text
gemini-3.5-transcribe
```

The model automatically identifies the spoken language and supports multilingual/code-switched audio. The app intentionally uses **verbatim** mode to preserve fillers, repetitions and dialect wording as closely as possible.
