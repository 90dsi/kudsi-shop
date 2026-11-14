@echo off
rem Starts a temporary public Cloudflare tunnel to the local Kudsi Shop server.
rem The URL printed below works for anyone while this window stays open.
cd /d "%~dp0"

set "CF=%LOCALAPPDATA%\Programs\cloudflared\cloudflared.exe"
if not exist "%CF%" (
  echo Downloading cloudflared...
  if not exist "%LOCALAPPDATA%\Programs\cloudflared" mkdir "%LOCALAPPDATA%\Programs\cloudflared"
  powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile '%CF%'"
  if not exist "%CF%" (
    echo Could not download cloudflared. Install it with: winget install --id Cloudflare.cloudflared
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)) { Start-Process python -ArgumentList 'app.py' -WorkingDirectory '%CD%'; Start-Sleep -Seconds 2 }"

echo.
echo Starting a public tunnel for http://localhost:3000
echo Keep this window open. Press Ctrl+C to stop the tunnel.
echo.
"%CF%" tunnel --url http://localhost:3000
pause
