@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\vite\bin\vite.js" (
  echo Dependencies are missing. Run pnpm install --frozen-lockfile first.
  pause
  exit /b 1
)
where node >nul 2>nul
if %errorlevel% equ 0 (
  node node_modules\vite\bin\vite.js --host 127.0.0.1
) else (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" node_modules\vite\bin\vite.js --host 127.0.0.1
  ) else (
    echo Node.js 22.12 or newer is required. See README.md.
    pause
    exit /b 1
  )
)
