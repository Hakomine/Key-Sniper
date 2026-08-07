@echo off
REM Schiebt Code-Aenderungen zu GitHub. Der Genre-Job zieht sie sich beim
REM naechsten stuendlichen Lauf selbst.
REM
REM Der cd-Befehl unten ist der eigentliche Zweck: aus dem Home-Verzeichnis
REM heraus findet git das Repo nicht.
cd /d "%~dp0"

echo.
echo   Aenderungen zu GitHub schieben...
echo.

REM Der Genre-Job committet stuendlich genres-db.json. Ohne Zusammenfuehren
REM scheitert jeder Push mit "fetch first".
git fetch origin
git merge --no-edit origin/main
if errorlevel 1 (
  REM Kollidieren kann praktisch nur die erzeugte Genre-Datenbank. Dafuer gilt:
  REM der Job hat recht, seine Version ist die frischere.
  echo.
  echo   genres-db.json kollidiert - nehme die Version vom Genre-Job.
  git checkout --theirs genres-db.json
  git add genres-db.json
  git commit --no-edit
  if errorlevel 1 goto :fehler
)

git push
if errorlevel 1 goto :fehler

echo.
echo   Worker zu Cloudflare deployen...
echo.
call npx wrangler deploy
if errorlevel 1 goto :fehler

echo.
echo   Fertig. Achte oben darauf, dass ZWEI Bindings gelistet sind:
echo   env.SNIPER_KV und env.GENRES_URL, dazu schedule: */10 * * * *
echo.
pause
exit /b 0

:fehler
echo.
echo   Abgebrochen - siehe Meldung oben.
echo.
pause
exit /b 1
