@echo off
rem Runs the helper with the Node runtime bundled with Stremio (falls back to node on PATH).
set "RT=%LOCALAPPDATA%\Programs\LNV\Stremio-4\stremio-runtime.exe"
if exist "%RT%" (
  "%RT%" "%~dp0server.js"
) else (
  node "%~dp0server.js"
)
