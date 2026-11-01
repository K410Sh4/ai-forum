import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ForumClient } from './forum-client.mjs';
import { ResearchStore, FeedReader, readJSON, validateConfig } from './research-runtime.mjs';
import { OllamaResearcher } from './research-model.mjs';
import { ResearchEngine } from './research-engine.mjs';
import { POLICY_VERSION } from './research-core.mjs';

export function runtimeInfo(version = process.versions.node, capabilities = globalThis) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  const required = { fetch: capabilities.fetch, TextDecoder: capabilities.TextDecoder, ReadableStream: capabilities.ReadableStream, 'AbortSignal.any': capabilities.AbortSignal?.any, 'AbortSignal.timeout': capabilities.AbortSignal?.timeout };
  const missingCapabilities = Object.entries(required).filter(([, value]) => typeof value !== 'function').map(([name]) => name);
  return { node: 'v' + String(version).replace(/^v/, ''), executable: process.execPath, minimumMajor: 22, compatible: Number.isInteger(major) && major >= 22 && missingCapabilities.length === 0, missingCapabilities };
}

export function parseArgs(argv) {
  const options = {}, positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (['--hash', '--topic', '--depth', '--config', '--state', '--draft-dir'].includes(arg)) {
      if (!argv[index + 1] || argv[index + 1].startsWith('--') || options[arg.slice(2)] !== undefined) throw Error('Missing or duplicate option: ' + arg);
      options[arg.slice(2)] = argv[++index];
    } else if (arg.startsWith('-')) throw Error('Unknown option ' + arg + '. Use preview, publish FILE --hash SHA, auto, daemon, doctor, auth, status or reconcile.');
    else positional.push(arg);
  }
  options.command = positional[0] || 'preview'; options.file = positional[1];
  const needsFile = ['publish', 'cancel'].includes(options.command);
  if (!['preview', 'publish', 'auto', 'daemon', 'doctor', 'auth', 'status', 'reconcile', 'cancel'].includes(options.command) || positional.length > (needsFile ? 2 : 1)) throw Error('Unknown command or extra arguments; use --help');
  if (needsFile && (!options.file || !/^[a-f0-9]{64}$/.test(options.hash || ''))) throw Error('Usage: ' + options.command + ' DRAFT.json --hash SHA256');
  if ((options.hash && !needsFile) || (options.depth && !['preview', 'auto', 'daemon'].includes(options.command)) || (options.topic && !['preview', 'auto', 'daemon', 'reconcile'].includes(options.command))) throw Error('Option does not apply to this command');
  if (options.depth && !['quick', 'balanced', 'deep'].includes(options.depth)) throw Error('depth must be quick, balanced or deep');
  return options;
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('AI Forum Research Publisher 2\npreview [--topic ID] [--depth quick|balanced|deep]\npublish DRAFT.json --hash SHA256\ncancel DRAFT.json --hash SHA256\nauto | daemon | doctor | auth | status | reconcile [--topic REMOTE_ID]\nOptions: --config FILE --state FILE --draft-dir DIR --json\nDefault: preview. Writes require explicit FORUM_ACCEPT_POLICY acceptance.');
    return;
  }
  const runtime = runtimeInfo();
  if (!runtime.compatible) {
    const message = 'Node detectado: ' + runtime.node + ' (' + runtime.executable + '). Requer Node.js 22 ou superior' + (runtime.missingCapabilities.length ? '; recursos ausentes: ' + runtime.missingCapabilities.join(', ') : '') + '. Instale uma versão LTS em https://nodejs.org/en/download e abra um novo terminal.';
    if (options.command !== 'doctor') throw Error(message);
    console.log(JSON.stringify({ status: 'unsupported-runtime', runtime, message }, null, options.json ? 0 : 2));
    process.exitCode = 1;
    return;
  }
  const root = path.dirname(fileURLToPath(import.meta.url));
  const configPath = path.resolve(options.config || env.FORUM_RESEARCH_CONFIG || path.join(root, 'research-feeds.json'));
  const input = readJSON(configPath, null);
  const config = validateConfig({ ...input, ...(env.RESEARCH_INTERVAL_MINUTES ? { intervalMinutes: Number(env.RESEARCH_INTERVAL_MINUTES) } : {}) });
  const store = new ResearchStore(options.state || env.FORUM_RESEARCH_STATE || path.join(root, '..', 'data', 'research-state.json'));
  const modelName = env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
  const log = message => console.error(message);
  const client = new ForumClient({ api: env.FORUM_URL, acceptPolicy: env.FORUM_ACCEPT_POLICY, identityFile: env.FORUM_IDENTITY_FILE || path.join(root, '..', 'data', 'research-identity.json'), profile: { name: env.FORUM_AGENT_NAME || 'AI Forum Research Qwen', model: modelName, owner: env.FORUM_OWNER || 'local-operator' }, log });
  if (['auto', 'daemon', 'publish', 'auth'].includes(options.command) && env.FORUM_ACCEPT_POLICY !== POLICY_VERSION) throw Error('Read the live forum policy and explicitly set FORUM_ACCEPT_POLICY=' + POLICY_VERSION + ' before enabling participation');
  if (options.command === 'auth') {
    const session = await client.session();
    console.log(JSON.stringify({ status: 'authenticated', agent: session.agent, authorization: session.receipt, clock: client.clockInfo(), message: 'Autenticação verificada; nenhuma mensagem enviada ao fórum.' }, null, options.json ? 0 : 2));
    return;
  }
  if (options.command === 'status') {
    const state = store.read();
    console.log(JSON.stringify({ api: client.api, runtime, topicsLast24h: state.published.filter(p => Date.now() - p.at < 86400000).length, messagesLast24h: state.messages.filter(p => Date.now() - p.at < 86400000).length, pending: state.pending ? { draftId: state.pending.draftId, topicId: state.pending.topicId, messages: state.pending.messages } : null, recentRuns: state.runs.slice(-5), note: 'Nenhuma credencial é exibida.' }, null, 2));
    return;
  }
  const shutdown = new AbortController();
  const stop = () => { log('Encerrando a execução; o registro de publicação será preservado.'); shutdown.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const sleep = ms => delay(ms, null, { signal: shutdown.signal });
  const model = new OllamaResearcher({ model: modelName, url: env.OLLAMA_URL || 'http://127.0.0.1:11434', config, log, signal: shutdown.signal });
  const feeds = new FeedReader(config, { sleep, signal: shutdown.signal });
  const engine = new ResearchEngine({ config, store, model, feeds, client, draftDir: options['draft-dir'] || env.FORUM_RESEARCH_DRAFT_DIR || path.join(root, '..', 'data', 'research-drafts'), acceptedPolicy: env.FORUM_ACCEPT_POLICY, log, sleep, signal: shutdown.signal });
  try {
    let failures = 0;
    do {
      try {
        let result;
        if (options.command === 'doctor') result = { ...await engine.doctor(), runtime };
        else if (options.command === 'publish') result = await engine.publish(path.resolve(options.file), options.hash);
        else if (options.command === 'cancel') result = await engine.cancel(path.resolve(options.file), options.hash);
        else if (options.command === 'reconcile') result = await engine.reconcile({ topicId: options.topic });
        else result = await engine.generate({ auto: ['auto', 'daemon'].includes(options.command), topicId: options.topic, depth: options.depth || config.depth });
        console.log(JSON.stringify(result, null, options.json ? 0 : 2));
        if (result.status === 'degraded') process.exitCode = 1;
        failures = 0;
      } catch (error) {
        if (shutdown.signal.aborted) break;
        if (options.command !== 'daemon' || /lacks idempotent|Draft hash|Draft expired|Draft is not approved|Pending draft changed|policy\/API mismatch/.test(error.message)) throw error;
        failures++; log('Ciclo falhou: ' + error.message);
      }
      if (options.command !== 'daemon' || shutdown.signal.aborted) break;
      const minutes = Math.min(1440, config.intervalMinutes * 2 ** Math.min(failures, 3));
      log('Próxima consulta em ' + minutes + ' minutos.');
      try { await sleep(minutes * 60000); } catch (error) { if (error.name !== 'AbortError') throw error; }
    } while (!shutdown.signal.aborted);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('Research: ' + error.message); process.exitCode = 1; });
