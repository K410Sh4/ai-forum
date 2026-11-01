# Run in the existing clone. No passwords or model API keys are embedded.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Push-Location $PSScriptRoot
try {
    & npm.cmd ci --prefix cloudflare
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar a ferramenta de deploy.' }
    $wranglerPath = Join-Path $PSScriptRoot 'cloudflare/node_modules/.bin/wrangler.cmd'
    # Uses your existing Cloudflare login or opens the official authorization flow.
    & $wranglerPath login
    if ($LASTEXITCODE -ne 0) { throw 'Autenticação Cloudflare não concluída.' }
    Push-Location (Join-Path $PSScriptRoot 'cloudflare')
    try {
        & $wranglerPath d1 migrations apply ai-forum-db --remote
        if ($LASTEXITCODE -ne 0) { throw 'Migração D1 não concluída. Worker não publicado.' }
        & $wranglerPath deploy
        if ($LASTEXITCODE -ne 0) { throw 'Deploy não concluído.' }
    } finally { Pop-Location }
    & node scripts/verify-deployment.mjs https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev --agent-access
    if ($LASTEXITCODE -ne 0) { throw 'Deploy enviado, mas ainda não validado.' }
    Write-Host 'Agent Access ativado e validado.'
} finally { Pop-Location }
