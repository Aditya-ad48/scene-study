"""Small Sarvam-only acting coach, runnable locally and on Vercel."""

import base64
import io
import json
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from pypdf import PdfReader
from sarvamai import SarvamAI

load_dotenv()
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("acting_coach")

ROOT = Path(__file__).resolve().parent
app = FastAPI(title="Scene Study — AI Acting Coach")
app.mount("/static", StaticFiles(directory=ROOT / "site"), name="static")

MAX_UPLOAD = 8 * 1024 * 1024
DOCUMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "character_context": {
            "type": "string",
            "description": "All legible details about the character, personality, motivation, emotional state, relationships, and scene. Preserve meaningful names and facts."
        }
    },
}


def sarvam() -> SarvamAI:
    key = os.getenv("SARVAM_API_KEY")
    if not key:
        raise HTTPException(503, "The Sarvam API key has not been configured on the server.")
    return SarvamAI(api_subscription_key=key)


def service_error(exc: Exception, task: str) -> HTTPException:
    log.exception("Sarvam %s failed", task)
    status = getattr(exc, "status_code", None)
    if status in (401, 403):
        return HTTPException(502, "Sarvam rejected the configured API key or account access.")
    if status == 429:
        return HTTPException(503, "Sarvam is rate limiting requests. Please try again shortly.")
    return HTTPException(502, f"Sarvam could not {task}. Please try again.")


@app.get("/", include_in_schema=False)
def home():
    return FileResponse(ROOT / "site" / "index.html")


@app.get("/api/health")
def health():
    return {"ready": bool(os.getenv("SARVAM_API_KEY"))}


async def read_upload(file: UploadFile, allowed: set[str]) -> bytes:
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if content_type not in allowed:
        raise HTTPException(400, "Please upload a supported file type.")
    data = await file.read(MAX_UPLOAD + 1)
    if not data or len(data) > MAX_UPLOAD:
        raise HTTPException(400, "The file must be between 1 byte and 8 MB.")
    return data


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    data = await read_upload(file, {
        "audio/webm", "audio/ogg", "audio/mp4", "audio/x-m4a",
        "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
    })
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    extension = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav"}[content_type]
    audio = io.BytesIO(data)
    audio.name = "performance" + extension
    try:
        result = sarvam().speech_to_text.transcribe(
            file=audio, model="saaras:v4", mode="transcribe"
        )
        return {"transcript": result.transcript or "", "language_code": result.language_code}
    except HTTPException:
        raise
    except Exception as exc:
        raise service_error(exc, "transcribe the recording") from exc


@app.post("/api/document")
async def document(file: UploadFile = File(...)):
    data = await read_upload(file, {"application/pdf", "image/png", "image/jpeg"})
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    if content_type == "application/pdf":
        try:
            reader = PdfReader(io.BytesIO(data))
            if len(reader.pages) > 10:
                raise HTTPException(400, "Please use a PDF of 10 pages or fewer.")
            extracted = "\n".join(page.extract_text() or "" for page in reader.pages).strip()
            if len(extracted) >= 80:
                return {"status": "complete", "text": extracted[:12000], "source": "PDF text"}
        except HTTPException:
            raise
        except Exception:
            # Scanned or unusual PDFs go to Sarvam Document AI.
            pass
    filename = re.sub(r"[^a-zA-Z0-9._-]", "_", file.filename or "character")[:80]
    if not filename.lower().endswith((".pdf", ".png", ".jpg", ".jpeg")):
        filename += {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg"}[content_type]
    try:
        job = sarvam().doc_ai.extract(
            file=[(filename, io.BytesIO(data), content_type)],
            schema=json.dumps(DOCUMENT_SCHEMA),
            output_format="json",
        )
        return {"status": "processing", "job_id": job.job_id}
    except HTTPException:
        raise
    except Exception as exc:
        raise service_error(exc, "read the character sketch") from exc


@app.get("/api/document/{job_id}")
def document_status(job_id: str):
    if not re.fullmatch(r"[a-zA-Z0-9-]{8,80}", job_id):
        raise HTTPException(400, "Invalid document job ID.")
    try:
        client = sarvam()
        result = client.doc_ai.get_status(job_id=job_id)
        status = result.status.lower()
        if status in {"failed", "rejected"}:
            raise HTTPException(422, "Sarvam could not read this sketch. Please paste its text instead.")
        if status in {"completed", "partially_completed"}:
            extracted = client.doc_ai.get_results(job_id=job_id).result
            value = extracted.get("character_context", "") if isinstance(extracted, dict) else str(extracted)
            return {"status": "complete", "text": str(value)[:12000], "source": "Sarvam Vision"}
        return {"status": "processing"}
    except HTTPException:
        raise
    except Exception as exc:
        raise service_error(exc, "finish reading the sketch") from exc


class FeedbackRequest(BaseModel):
    character: str = Field(min_length=1, max_length=6000)
    document_text: str = Field(default="", max_length=12000)
    dialogue: str = Field(min_length=1, max_length=2500)
    recorded: bool = False


@app.post("/api/feedback")
def feedback(payload: FeedbackRequest):
    prompt = f"""You are an encouraging, specific acting coach. Analyze only the provided character notes and dialogue transcript. You cannot hear the recording. Never claim to have measured pitch, tone, volume, pace, or emotion in the actor's actual voice. If recorded, call it a transcript and make delivery suggestions conditional. Preserve the original dialogue words in demo_text as much as possible; punctuation may add natural pauses. Give 2-3 real fictional movie character references, with accurate film titles. They are for study, not imitation. Respond in the dialogue's language when possible. Return ONLY a JSON object with these keys: interpretation (string), emotion (string), subtext (string), strengths (string), delivery (string), adjustments (array of 3 specific strings), emphasis (array of 1-3 exact words or short phrases from the dialogue), pauses (string), demo_text (string, maximum 2500 characters), change_summary (string), recommendations (array of 2-3 objects with character, film, why, observe strings). Do not invent scene facts absent from the notes.\n\nCHARACTER NOTES:\n{payload.character}\n\nUPLOADED SKETCH:\n{payload.document_text or '(none)'}\n\nDIALOGUE {('(transcribed from a recording)' if payload.recorded else '(typed)')}:\n{payload.dialogue}"""
    try:
        result = sarvam().chat.completions(
            model="sarvam-105b",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_tokens=1800,
            reasoning_effort=None,
        )
        raw = result.choices[0].message.content or ""
        data = json.loads(raw)
        required = {"interpretation", "emotion", "subtext", "strengths", "delivery", "adjustments", "emphasis", "pauses", "demo_text", "change_summary", "recommendations"}
        if not required.issubset(data) or not isinstance(data["adjustments"], list) or not isinstance(data["recommendations"], list):
            raise ValueError("Incomplete coach response")
        data["demo_text"] = str(data["demo_text"])[:2500] or payload.dialogue
        return data
    except HTTPException:
        raise
    except Exception as exc:
        raise service_error(exc, "prepare acting feedback") from exc


class VoiceRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2500)
    pace: float = Field(default=1.0, ge=0.5, le=2.0)
    language_code: str = "en-IN"


@app.post("/api/voice")
def voice(payload: VoiceRequest):
    allowed = {"en-IN", "hi-IN", "bn-IN", "ta-IN", "te-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "pa-IN", "od-IN"}
    if payload.language_code not in allowed:
        raise HTTPException(400, "This text-to-speech language is not supported.")
    try:
        result = sarvam().text_to_speech.convert(
            text=payload.text,
            language_code=payload.language_code,
            model="bulbul:v4-flash",
            output_audio_codec="mp3",
            pace=payload.pace,
        )
        if not result.audios:
            raise ValueError("Empty audio response")
        return {"audio": "data:audio/mpeg;base64," + result.audios[0]}
    except HTTPException:
        raise
    except Exception as exc:
        raise service_error(exc, "generate a voice demonstration") from exc
