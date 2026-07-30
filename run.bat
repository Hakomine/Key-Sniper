@echo off
cd /d "%~dp0"
echo.
echo   Key Sniper - suche nach Schnaeppchen...
echo.
node collector.mjs
if %errorlevel% neq 0 (
  echo.
  echo   Fehler beim Sammeln. Ist der API-Key in config.json eingetragen?
  echo.
  pause
  exit /b 1
)
start "" "Key Sniper.html"
