import os
import tempfile

import streamlit as st
from dotenv import load_dotenv
from google import genai
from jiwer import cer, wer

load_dotenv()

st.set_page_config(page_title="Arabic STT Benchmark", page_icon="🎙️", layout="centered")

st.title("🎙️ Arabic STT Benchmark Lab")
st.caption("Transcribe audio with Gemini and measure WER/CER against a human reference.")

api_key = os.getenv("GEMINI_API_KEY")

if not api_key:
    st.warning("Add GEMINI_API_KEY to a local .env file before transcribing.")

uploaded_file = st.file_uploader(
    "Upload audio",
    type=["wav", "mp3", "m4a", "ogg", "flac", "webm", "aac"],
)

reference_text = st.text_area(
    "Ground-truth transcript (optional)",
    placeholder="Paste the human-verified transcript here to calculate WER and CER...",
    height=140,
)

if uploaded_file:
    st.audio(uploaded_file)

    if st.button("Transcribe", type="primary", disabled=not api_key):
        suffix = os.path.splitext(uploaded_file.name)[1] or ".wav"
        temp_path = None

        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
                temp_file.write(uploaded_file.getbuffer())
                temp_path = temp_file.name

            client = genai.Client(api_key=api_key)

            with st.spinner("Transcribing audio..."):
                audio_file = client.files.upload(file=temp_path)
                response = client.models.generate_content(
                    model="gemini-3.5-transcribe",
                    contents=[audio_file],
                )

            transcript = (response.text or "").strip()

            st.subheader("Transcript")
            st.text_area("Gemini output", transcript, height=220)

            if reference_text.strip() and transcript:
                reference = reference_text.strip()
                word_error_rate = wer(reference, transcript)
                char_error_rate = cer(reference, transcript)

                col1, col2 = st.columns(2)
                col1.metric("WER", f"{word_error_rate:.2%}")
                col2.metric("CER", f"{char_error_rate:.2%}")

                st.caption("Lower is better. 0% means an exact match.")

            st.download_button(
                "Download transcript",
                data=transcript,
                file_name="transcript.txt",
                mime="text/plain",
            )

        except Exception as exc:
            st.error(f"Transcription failed: {exc}")

        finally:
            if temp_path and os.path.exists(temp_path):
                os.remove(temp_path)

st.divider()
st.markdown(
    "**Next experiment:** test Saudi dialect clips, names, numbers, and Arabic-English code-switching, then compare WER/CER by category."
)
