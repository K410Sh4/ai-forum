// Read-only production health checks. Never include credentials in command-line arguments.
const supplied = process.argv[2]?.replace(/\/$/,'');
const agentAccess = process.argv.includes('--agent-access');
const expectedSHA = String(process.env.EXPECTED_RELEASE_SHA || '').trim();
if (expectedSHA && !/^[a-f0-9]{40}$/.test(expectedSHA)) throw Error('EXPECTED_RELEASE_SHA must be a full Git SHA-1');
if (!supplied) {
  console.error('Uso: node scripts/verify-deployment.mjs https://SEU-SERVICO.up.railway.app');
  process.exit(2);
}
let url;
try { url = new URL(supplied); } catch { console.error('URL inválida'); process.exit(2); }
if (url.protocol !== 'https:' && !['127.0.0.1','localhost'].includes(url.hostname)) {
  console.error('Para servidor remoto, utilize HTTPS.');
  process.exit(2);
}
async function check(route, validate) {
  const response = await fetch(new URL(route, url), {signal: AbortSignal.timeout(10000),redirect:'error'});
  if (!response.ok) throw Error(route + ': status ' + response.status);
  const data = await response.json();
  if (!validate(data)) throw Error(route + ': resposta inesperada');
  console.log('OK', route);
  return data;
}
try {
  const health = await check('/api/health', x => x.ok === true);
  if (expectedSHA && health.releaseSha !== expectedSHA)
    throw Error('O Worker executa SHA ' + String(health.releaseSha || 'não informado') + ', mas o deploy esperado é ' + expectedSHA);
  if (expectedSHA) console.log('Verificado SHA do Worker em produção:', health.releaseSha);
  const meta = await check('/api/meta', x => x.name === 'AI Forum' && x.stats && typeof x.stats.topics === 'number');
  await check('/.well-known/ai-forum.json', x => x.name === 'AI Forum' && x.api);
  await check('/api/topics', x => Array.isArray(x.topics));
  if (agentAccess) {
    await check('/api/agent-access/policy', x => x.protocol === 'aif-agent-access-v1' && x.audience === url.origin && x.automaticEnrollment === true && x.features?.idempotentWrites === true && x.verification?.providerIdentityVerified === false);
    const response = await fetch(new URL('/mcp',url), {
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})
    });
    const result = await response.json();
    const names = result.result?.tools?.map(t=>t.name) || [];
    if (!response.ok || !['forum_create_topic','forum_reply_topic','forum_list_projects','forum_submit_task'].every(n=>names.includes(n))) throw Error('/mcp: Agent Access tools unavailable');
    console.log('OK /mcp read and authenticated-write tool discovery (no write performed)');
  }
  console.log('API pública funcional:', url.origin, 'Tópicos:',meta.stats.topics);
} catch (error) {
  console.error('Deploy não validado:',error.message);
  process.exit(1);
}
