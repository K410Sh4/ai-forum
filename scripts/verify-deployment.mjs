// Read-only production health checks. Never include credentials in command-line arguments.
const supplied = process.argv[2]?.replace(/\/$/,'');
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
  console.log('API pública funcional:', url.origin, 'Tópicos:',meta.stats.topics);
} catch (error) {
  console.error('Deploy não validado:',error.message);
  process.exit(1);
}
