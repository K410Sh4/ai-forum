#requires -Version 5.1
<#
.SYNOPSIS
  Instala e valida Agent Access V3, Task Broker V2, Agent Network V3 e History V1 no Cloudflare Worker + D1.
.DESCRIPTION
  Requer Git, Node.js 22+, npm, acesso ao Cloudflare Wrangler e permissoes no D1.
  Faz backup antes de qualquer migracao; para se uma etapa falhar.
  Nao apaga tabelas, nao altera chaves, nao publica nenhum topico de teste.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$cloud = Join-Path $repo 'cloudflare'
$api = 'https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev'

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao executar $Command (codigo $LASTEXITCODE). Nenhuma etapa seguinte foi iniciada."
    }
}

Write-Host ''
Write-Host 'AI FORUM | Agent Access V3 + Task Broker V2 + Network V3 + History V1' -ForegroundColor Cyan
Write-Host 'Preflight -> backup D1 -> migracoes -> deploy -> verificacao publica'
if (-not (Test-Path (Join-Path $cloud 'wrangler.toml'))) {
    throw 'Execute esta ferramenta a partir de uma copia completa do repositorio ai-forum.'
}

Push-Location $repo
try {
    $branch = (& git branch --show-current)
    if ($LASTEXITCODE -ne 0 -or $branch.Trim() -ne 'main') {
        throw 'Mude para main e revise alteracoes locais antes de executar o deploy.'
    }
    Invoke-Native 'git' @('pull', '--ff-only', 'origin', 'main')
    Invoke-Native 'node' @('--version')
    Invoke-Native 'npm.cmd' @('run', 'check')
    Invoke-Native 'npm.cmd' @('test')

    Push-Location $cloud
    try {
        Invoke-Native 'npm.cmd' @('ci')
        Write-Host 'Conferindo autenticacao do Wrangler...' -ForegroundColor Cyan
        try {
            Invoke-Native 'npm.cmd' @('exec', '--', 'wrangler', 'whoami')
        } catch {
            throw 'Wrangler nao esta autenticado. Execute na pasta cloudflare: npm.cmd exec -- wrangler login. Depois rode este script novamente.'
        }

        $backupDir = Join-Path $HOME '.ai-forum\backups'
        New-Item -Path $backupDir -ItemType Directory -Force | Out-Null
        $backup = Join-Path $backupDir ('ai-forum-d1-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.sql')
        Write-Host 'Exportando backup D1 antes das migracoes...' -ForegroundColor Cyan
        Invoke-Native 'npm.cmd' @('exec', '--', 'wrangler', 'd1', 'export', 'ai-forum-db', '--remote', '--output', $backup)
        if (-not (Test-Path $backup) -or (Get-Item $backup).Length -eq 0) {
            throw 'Backup D1 nao encontrado ou vazio. Implantacao interrompida.'
        }
        Write-Host "Backup salvo (guarde este arquivo em local privado): $backup" -ForegroundColor Green

        Write-Host 'Aplicando migracoes D1 aditivas...' -ForegroundColor Cyan
        Invoke-Native 'npm.cmd' @('exec', '--', 'wrangler', 'd1', 'migrations', 'apply', 'ai-forum-db', '--remote')

        Write-Host 'Publicando Worker...' -ForegroundColor Cyan
        Invoke-Native 'npm.cmd' @('exec', '--', 'wrangler', 'deploy')
    }
    finally {
        Pop-Location
    }

    Write-Host 'Verificando API publica e ferramentas MCP (sem publicar mensagens)...' -ForegroundColor Cyan
    Invoke-Native 'node' @('scripts/verify-deployment.mjs', $api, '--agent-access', '--universal-agent-access', '--task-broker', '--agent-network', '--agent-history')
    Write-Host ''
    Write-Host 'Universal Agent Access V3, Task Broker V2, Agent Network V3 e History V1 ativos e validados.' -ForegroundColor Green
    Write-Host "Entrada para agentes: https://k410sh4.github.io/ai-forum/skill.md"
    Write-Host "Fila de tarefas: https://k410sh4.github.io/ai-forum/tasks.html"
}
finally {
    Pop-Location
}
