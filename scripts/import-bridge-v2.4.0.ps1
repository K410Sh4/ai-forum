#requires -Version 5.1
<#
.SYNOPSIS
  Importa o ZIP local AI-Forum Bridge v2.4.0 para o GitHub, em uma branch e PR.
.DESCRIPTION
  Nao altera a pasta original ai-forum nem publica no Cloudflare.
  Exige Git e Node.js para testes; gh CLI para abrir PR automaticamente.
  A publicacao em GitHub requer confirmacao manual.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\import-bridge-v2.4.0.ps1 -ZipPath "$HOME\Downloads\AI-Forum-Bridge-Reconstruido-v2.4.0.zip"
#>
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ZipPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoUrl = 'https://github.com/K410Sh4/ai-forum.git'
$targetFolder = 'extensions/ai-forum-bridge-v2.4.0'

function Run([string]$command, [string[]]$arguments) {
    & $command @arguments
    if ($LASTEXITCODE -ne 0) { throw "$command falhou com codigo $LASTEXITCODE" }
}

$zipFile = (Resolve-Path -LiteralPath $ZipPath -ErrorAction Stop).Path
if ([IO.Path]::GetExtension($zipFile).ToLowerInvariant() -ne '.zip') {
    throw 'Escolha um arquivo ZIP. O script nao baixa executaveis externos.'
}
Add-Type -AssemblyName System.IO.Compression
$archive = [IO.Compression.ZipFile]::OpenRead($zipFile)
try {
    $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
    $names = @($entries | ForEach-Object FullName)
    foreach ($name in $names) {
        if ($name -notmatch '^[A-Za-z0-9_.\-/]+$' -or
            $name.StartsWith('/') -or $name.Contains('\\') -or
            ($name.Split('/') -contains '..')) {
            throw "Nome inseguro no ZIP: $name"
        }
    }
    foreach ($required in @('manifest.json','background.js','content.js','dashboard.html','dashboard.js','dashboard.css','protocol.js','README.md','tests/five-providers.test.mjs')) {
        if ($names -notcontains $required) { throw "Arquivo obrigatorio ausente do ZIP: $required" }
    }
    $manifestEntry = $archive.GetEntry('manifest.json')
    $reader = New-Object IO.StreamReader($manifestEntry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($manifest.version -ne '2.4.0' -or $manifest.manifest_version -ne 3) {
        throw 'O ZIP nao corresponde ao Bridge 2.4.0 Manifest V3.'
    }
}
finally { $archive.Dispose() }

foreach ($cmd in @('git','node')) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Instale $cmd antes de continuar." }
}
$root = Join-Path $env:LOCALAPPDATA 'AI-Forum\BridgeSync'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$work = Join-Path $root ('import-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6))
Write-Host 'Criando copia isolada do repositorio...' -ForegroundColor Cyan
Run 'git' @('clone','--depth','1','--branch','main',$repoUrl,$work)
$branchName = 'feat/bridge-v2-4-import-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Run 'git' @('-C',$work,'checkout','-b',$branchName)

$target = Join-Path $work $targetFolder
New-Item -ItemType Directory -Force -Path $target | Out-Null
Expand-Archive -LiteralPath $zipFile -DestinationPath $target -Force
$manifestInstalled = Get-Content -Raw -LiteralPath (Join-Path $target 'manifest.json') | ConvertFrom-Json
if ($manifestInstalled.version -ne '2.4.0') { throw 'Falha na verificacao de versao apos extracao.' }

Write-Host 'Executando testes locais da versao 2.4.0...' -ForegroundColor Cyan
$testFiles = @(Get-ChildItem -LiteralPath (Join-Path $target 'tests') -Filter '*.test.mjs' | ForEach-Object FullName)
if ($testFiles.Count -lt 4) { throw 'Suite de testes incompleta.' }
Run 'node' (@('--test') + $testFiles)

Write-Host 'Executando validacoes do repositorio principal...' -ForegroundColor Cyan
Push-Location $work
try {
    Run 'npm.cmd' @('run','check')
    Run 'npm.cmd' @('test')
}
finally { Pop-Location }

Run 'git' @('-C',$work,'add','--',$targetFolder)
Write-Host 'Arquivos preparados para envio:' -ForegroundColor Cyan
Run 'git' @('-C',$work,'diff','--cached','--stat')

$confirmation = Read-Host 'Digite PUBLICAR para enviar a branch ao GitHub e abrir um PR'
if ($confirmation -cne 'PUBLICAR') {
    Write-Host 'Cancelado. Nenhum push realizado. A copia permanece em:' $work -ForegroundColor Yellow
    exit 0
}

Run 'git' @('-C',$work,'commit','-m','feat(bridge): adicionar fontes e testes da extensao automatica v2.4.0')
Run 'git' @('-C',$work,'push','--set-upstream','origin',$branchName)

if (Get-Command 'gh' -ErrorAction SilentlyContinue) {
    Run 'gh' @('pr','create','--repo','K410Sh4/ai-forum','--base','main','--head',$branchName',
      '--title','feat(bridge): integrar codigo-fonte v2.4.0 de cinco IAs',
      '--body','Importacao isolada do ZIP local Bridge 2.4.0, sem alterar o legado 1.1.0. Testes Node locais e suite do projeto executados. Copilot/Meta AI seguem experimentais. Revisar permissoes Manifest V3 antes de fazer merge.')
} else {
    Write-Host 'Branch publicada. Para abrir PR, acesse:' -ForegroundColor Yellow
    Write-Host ('https://github.com/K410Sh4/ai-forum/compare/main...' + $branchName + '?expand=1')
}
Write-Host 'Copia de trabalho preservada:' $work -ForegroundColor Green
