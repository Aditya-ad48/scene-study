# Scene Study

A small, single-page acting coach powered only by Sarvam AI. FastAPI serves the page and keeps the API key on the server.

## Local setup

1. Create a Python 3.12 virtual environment and install `requirements.txt`.
2. Copy `.env.example` to `.env` and set `SARVAM_API_KEY` to your Sarvam key.
3. Run `uvicorn app:app --reload` and open `http://127.0.0.1:8000`.

Example commands:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload
```

The app records a browser microphone take for up to 30 seconds, transcribes it with Saaras v4, asks Sarvam 105B for text-based acting direction, and generates a Bulbul v4 Flash voice reference. Its feedback is based on the transcript and character notes; it does not measure the actor's vocal tone. Original recordings stay in the browser for the current session. Typed lines get a neutral Sarvam voice reading for the A side of the comparison.

Text PDFs are read locally. Images and scanned PDFs use Sarvam Document AI, which may take longer or require document access on the Sarvam account. You can always paste sketch details into the character notes.

## Vercel

This project follows Vercel's FastAPI layout with `app.py` as the entrypoint. Create or link a Vercel project from this directory, set `SARVAM_API_KEY` as a server secret for Production (and Preview if needed), then deploy. Do not enter the key in the page or commit `.env`; `.vercelignore` also excludes it from uploads.

```bash
vercel
vercel env add SARVAM_API_KEY production --visibility secret
vercel env add SARVAM_API_KEY preview --visibility secret
vercel --prod
```

The app has no database or accounts. Refreshing the page starts a new practice session.
