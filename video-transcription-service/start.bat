@echo off
setlocal

if not exist ".env" (
  if exist ".env.example" (
    copy .env.example .env >nul
    echo Created .env from .env.example
  )
)

if not exist ".venv" (
  echo Creating Python virtual environment...
  python -m venv .venv
)

call .venv\Scripts\activate.bat
echo Installing dependencies...
pip install --upgrade pip >nul
pip install -r requirements.txt

echo.
echo Starting ClipScribe on http://localhost:8000 ...
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
