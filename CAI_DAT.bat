@echo off
chcp 65001 >nul
title Veu Dow - Kiem tra phan mem can thiet
echo ==========================================
echo   VEU DOW - KIEM TRA PHAN MEM
echo ==========================================
echo.

REM App da bundle yt-dlp + ffmpeg trong folder bin\ -> thuong khong can cai gi.
if exist "%~dp0bin\yt-dlp.exe" (
  echo [OK] yt-dlp da co san trong bin\
) else (
  echo [!] Thieu bin\yt-dlp.exe - dang thu cai qua winget...
  winget install --id yt-dlp.yt-dlp -e --accept-source-agreements --accept-package-agreements
)

if exist "%~dp0bin\ffmpeg.exe" (
  echo [OK] ffmpeg da co san trong bin\
) else (
  echo [!] Thieu bin\ffmpeg.exe - dang thu cai qua winget...
  winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
)

echo.
echo Kiem tra xong! App co the chay bang MO_APP.bat
echo.
pause
