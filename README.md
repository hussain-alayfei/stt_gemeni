# Arabic STT Benchmark Lab with Gemini

A small Streamlit project for testing speech-to-text quality with Google's Gemini transcription model.

## What it does

- Upload an audio file (`WAV`, `MP3`, `M4A`, `OGG`, `FLAC`, `WEBM`)
- Transcribe speech using `gemini-3.5-transcribe`
- Optionally paste a ground-truth transcript
- Measure **WER (Word Error Rate)** and **CER (Character Error Rate)**
- Download the generated transcript

## Why this project?

Speech-to-text should be evaluated, not only listened to. This app lets you compare Gemini's transcript against a known reference and quantify the errors.

Example:

- Ground truth: `السلام عليكم كيف حالك`
- Prediction: `السلام عليكم كيف حالكم`
- The app calculates WER/CER automatically.

## Setup

### 1. Clone

```bash
git clone https://github.com/hussain-alayfei/stt_gemeni.git
cd stt_gemeni
```

### 2. Create a virtual environment

```bash
python -m venv .venv
```

Windows:

```bash
.venv\Scripts\activate
```

macOS/Linux:

```bash
source .venv/bin/activate
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
```

### 4. Add your Gemini API key

Create a `.env` file:

```env
GEMINI_API_KEY=your_key_here
```

Never commit your real API key.

### 5. Run

```bash
streamlit run app.py
```

## Suggested next experiments

1. Collect 20-50 short Saudi Arabic clips.
2. Create a human-verified reference transcript for each clip.
3. Measure WER/CER per clip.
4. Group mistakes into names, dialect words, numbers, and English code-switching.
5. Add custom vocabulary and compare before/after accuracy.
6. Compare multiple STT models using the exact same benchmark.

## Stack

- Python
- Streamlit
- Google Gen AI SDK
- Gemini 3.5 Transcribe
- jiwer

## Goal

Turn this repository into a reproducible benchmark for Arabic and Saudi-dialect speech-to-text systems.
