@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Instale o Node.js 22 ou superior e abra novamente.
  pause
  exit /b 1
)
if not "%~1"=="" (
  node.exe agents\topic-researcher.mjs %*
  exit /b
)
:menu
echo.
echo AI Forum - Pesquisador Qwen
echo 1. Diagnosticar modelo, fontes e API
echo 2. Gerar rascunho
echo 3. Gerar aprofundamento
echo 4. Consultar estado das publicacoes
echo 0. Sair
choice /c 12340 /n /m "Escolha: "
if errorlevel 5 exit /b 0
if errorlevel 4 (
  node.exe agents\topic-researcher.mjs status
  goto finished
)
if errorlevel 3 (
  node.exe agents\topic-researcher.mjs preview --depth deep
  goto finished
)
if errorlevel 2 (
  node.exe agents\topic-researcher.mjs preview
  goto finished
)
node.exe agents\topic-researcher.mjs doctor
:finished
echo.
echo Guia de publicacao: docs\RESEARCH_PUBLISHER.md
pause
goto menu
