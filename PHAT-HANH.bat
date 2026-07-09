@echo off
REM ============================================================
REM  PHAT HANH BAN MOI - Veu Media Downloader
REM  Chay file nay moi khi muon day ban cap nhat cho nhan vien
REM ============================================================
setlocal
cd /d "%~dp0"
set "PATH=%PATH%;C:\Program Files\GitHub CLI;C:\Program Files\Git\cmd"
set CSC_IDENTITY_AUTO_DISCOVERY=false

echo.
echo ===== PHAT HANH BAN MOI =====
echo.
echo Version hien tai trong package.json:
findstr /C:"\"version\"" package.json
echo.
echo *** NHO: sua so version trong package.json TRUOC khi chay (vd 1.0.0 -^> 1.0.1) ***
echo.
pause

echo.
echo [1/3] Lay token GitHub...
for /f "delims=" %%t in ('gh auth token') do set "GH_TOKEN=%%t"

echo [2/3] Commit + push code len GitHub...
git add -A
git commit -m "Release update"
git push origin main

echo [3/3] Build + publish len GitHub Releases...
call npx electron-builder --win --x64 --publish always

echo.
echo ===== XONG! =====
echo May nhan vien se tu nhan ban moi trong lan mo app ke tiep.
echo.
pause
