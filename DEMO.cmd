@echo off
REM ============================================================
REM  Agent Eye LIVE DEMO — double-click me!
REM  A browser window WILL pop up on your desktop with a red
REM  cursor driving the Nexus AI store end-to-end.
REM ============================================================
cd /d "%~dp0"

echo [1/3] Checking backend (FastAPI + SQLite on :8000)...
curl -s -o NUL --max-time 2 http://127.0.0.1:8000/api/health
if errorlevel 1 (
  echo    starting backend...
  start "AI-Shop Backend" cmd /k "cd /d %~dp0test\ai-shop\backend && python -m uvicorn main:app --host 127.0.0.1 --port 8000"
)

echo [2/3] Checking frontend (Flutter release build on :5500)...
curl -s -o NUL --max-time 2 http://127.0.0.1:5500
if errorlevel 1 (
  echo    starting frontend...
  start "AI-Shop Frontend" cmd /k "cd /d %~dp0test\ai-shop\frontend\build\web && python -m http.server 5500 --bind 127.0.0.1"
)

timeout /t 3 /nobreak >NUL

echo [3/3] Launching the demo — WATCH FOR THE BROWSER WINDOW...
cd packages\mcp-server
node live-demo.mjs

echo.
echo Demo finished. Press any key to close.
pause >NUL
