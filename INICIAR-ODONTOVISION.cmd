@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js nao encontrado. Instale Node.js 22 ou superior.
  pause
  exit /b 1
)
if not exist "node_modules\next\dist\bin\next" (
  echo Dependencias ausentes. No terminal desta pasta, rode: npm ci
  pause
  exit /b 1
)
echo.
echo ODONTOVISION - visualizador local CBCT/DICOM
echo Abra no navegador: http://localhost:3000
echo Pressione Ctrl+C para encerrar.
echo.
call npm run dev
pause
