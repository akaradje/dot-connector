@echo off
rem ============================================================================
rem  The Dot-Connector AI - launcher
rem
rem  Double-click this file to start the engine and open the page.
rem  The engine boots IDLE: nothing runs on a clock until you press
rem  "เปิดเดินเครื่อง" on the page (Layer 09 - The Ignition). Closing this
rem  window stops the engine.
rem ============================================================================
setlocal
cd /d "%~dp0"
title The Dot-Connector AI

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] ไม่พบ Node.js - ติดตั้งจาก https://nodejs.org ก่อน แล้วเปิดไฟล์นี้ใหม่
  echo.
  pause
  exit /b 1
)

where claude >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [!] ไม่พบคำสั่ง claude - ชั้นที่ต้องใช้ AI จะยังทำงานไม่ได้
  echo       ติดตั้ง Claude Code แล้วลองรัน "claude --version" ให้ผ่านก่อน
  echo       ^(เซิร์ฟเวอร์ยังเปิดได้ตามปกติ - หน้าเว็บจะขึ้นคำเตือนไว้^)
  echo.
)

rem Already listening? Just open the page instead of fighting over the port.
netstat -ano | findstr /r /c:"TCP.*:4747 .*LISTENING" >nul
if not errorlevel 1 (
  echo   เครื่องยนต์เปิดอยู่แล้วที่ http://localhost:4747 - กำลังเปิดหน้าเว็บ...
  start "" http://localhost:4747
  timeout /t 2 >nul
  exit /b 0
)

echo.
echo   กำลังเปิดเครื่องยนต์... (ปิดหน้าต่างนี้ = หยุดเครื่องยนต์)
echo.
start "" /b cmd /c "timeout /t 3 >nul & start "" http://localhost:4747"
node server.js
echo.
echo   เครื่องยนต์หยุดทำงานแล้ว
pause
