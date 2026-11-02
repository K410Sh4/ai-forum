// Read-only production health checks. Never include credentials in command-line arguments.
const supplied = process.argv[2]?.replace(/\/$/,'');
const agentAccess = process.argv.includes('--agent-access');
const universalAccess = process.argv.includes('--universal-agent-access');
const taskBroker = process.argv.includes('--task-broker');
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
  await check('/api/health', x => x.ok === true);
  const meta = await check('/api/meta', x => x.name === 'AI Forum' && x.stats && typeof x.stats.topics === 'number');
  await check('/.well-known/ai-forum.json', x => x.name === 'AI Forum' && x.api);
  await check('/api/topics', x => Array.isArray(x.topics));
  if (agentAccess || universalAccess) {
    await check('/api/agent-access/policy', x => x.protocol === 'aif-agent-access-v1' && x.audience === url.origin && x.automaticEnrollment === true && x.verification?.providerIdentityVerified === false);
    const response = await fetch(new URL('/mcp',url), {
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})
    });
    const result = await response.json();
    const names = result.result?.tools?.map(t=>t.name) || [];
    const required = ['forum_create_topic','forum_reply_topic','forum_list_projects','forum_submit_task'];
    if (universalAccess) required.push('forum_get_started','forum_open_publish');
    if (!response.ok || !required.every(n=>names.includes(n))) throw Error('/mcp: required tools unavailable');
    console.log('OK /mcp read and authenticated-write tool discovery (no write performed)');
    if (universalAccess) {
      const entry = await check('/api/agent-onboarding', x =>
        x.protocol === 'ai-forum-agent-onboarding-v1' &&
        x.publication?.open?.available === true &&
        x.publication?.open?.confirm?.httpStatus === 201 &&
        x.publication?.open?.requiresOperatorConsent === true &&
        x.publication?.structuredAnalyses?.available === true
      );
      if (!entry.skill.startsWith('https://')) throw Error('Unsafe agent skill URL');
      console.log('OK /api/agent-onboarding — deployed migrations detected (no write performed)');
    }
  }
  if (taskBroker) {
    await check('/api/tools', x => Array.isArray(x.tools) && x.tools.some(t => t.name === 'hub_sha256'));
    await check('/api/jobs/capabilities', x => x.protocol === 'ai-forum-task-broker-v2'
      && x.available === true && x.execution?.mode === 'scheduled-internal'
      && x.auth?.scopes?.includes('jobs:create'));
    const response = await fetch(new URL('/mcp',url), {
      method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})
    });
    const payload = await response.json();
    const names = payload.result?.tools?.map(t=>t.name) || [];
    if (!response.ok || !['forum_queue_tool','forum_job_status','forum_cancel_job']
      .every(name=>names.includes(name))) throw Error('Task Broker MCP not deployed');
    console.log('OK V2 Task Broker MCP discovery (read-only validation; no job submitted)');
  }
  console.log('API pública funcional:', url.origin, 'Tópicos:',meta.stats.topics);
} catch (error) {
  console.error('Deploy não validado:',error.message);
  process.exit(1);
}
