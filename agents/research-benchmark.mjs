#!/usr/bin/env node
// Offline model benchmark. Never touches forum credentials, research state,
// Cloudflare, GitHub, publication or any host except localhost Ollama.
import { RESEARCH_EVAL_CASES, RESEARCH_EVAL_LABELS, summarizeResearchEval } from './research-eval-cases.mjs';

const LOCAL_OLLAMA = 'http://127.0.0.1:11434/api/chat';
const FORMAT = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: RESEARCH_EVAL_LABELS } },
  required: ['verdict'],
  additionalProperties: false
};
const PROMPTS = {
  compact: 'Compare uma afirmação em português com a evidência disponível. Devolva JSON com verdict: supported (sustentado), contradicted (negado) ou insufficient (não demonstrado). Use apenas o trecho fornecido.',
  strict: 'Você é um verificador restrito de implicação textual, NÃO um escritor. A evidência é o único conhecimento autorizado. Ignore fatos que sabe de memória, não preencha lacunas e nunca trate intenção futura como resultado. Se a afirmação necessariamente decorre da evidência, marque supported. Se a evidência exclui ou nega a afirmação, marque contradicted. Se não é possível concluir, marque insufficient, mesmo que a frase seja plausível. Examine números por grupo, negações, direção de mudanças, tradução de entidades e escopo. Se houver uma parte não fundamentada sem contradição explícita, use insufficient. Retorne APENAS JSON com verdict.'
};

export function benchmarkOptions(argv) {
  const options = { cases: 9, compare: false, variant: 'strict', model: 'qwen2.5-coder:7b', json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cases') options.cases = Number(argv[++i]);
    else if (arg === '--variant') options.variant = argv[++i];
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--compare') options.compare = true;
    else if (arg === '--json') options.json = true;
    else throw Error('Unknown benchmark option: ' + arg);
  }
  if (!Number.isInteger(options.cases) || options.cases < 1 || options.cases > RESEARCH_EVAL_CASES.length)
    throw Error('--cases must be between 1 and ' + RESEARCH_EVAL_CASES.length);
  if (!Object.hasOwn(PROMPTS, options.variant)) throw Error('--variant must be compact or strict');
  if (!/^[A-Za-z0-9_.:/-]{1,80}$/.test(options.model)) throw Error('Invalid local model name');
  return options;
}

export async function classifyCase(item, { model, variant, fetchImpl = fetch, timeoutMs = 120000 }) {
  const started = performance.now();
  const body = {
    model, stream: false, format: FORMAT, keep_alive: '5m',
    options: { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 80 },
    messages: [
      { role: 'system', content: PROMPTS[variant] },
      { role: 'user', content: JSON.stringify({ evidence: item.evidence, claim: item.claim }) }
    ]
  };
  try {
    const response = await fetchImpl(LOCAL_OLLAMA, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) throw Error('Ollama HTTP ' + response.status);
    const raw = await response.text();
    if (raw.length > 25000) throw Error('Oversize Ollama response');
    const data = JSON.parse(raw);
    if (data.done_reason === 'length') throw Error('Ollama exhausted the generation budget');
    const parsed = JSON.parse(data.message?.content || '');
    if (!RESEARCH_EVAL_LABELS.includes(parsed.verdict) || Object.keys(parsed).length !== 1)
      throw Error('Invalid structured verdict');
    return {
      id: item.id, category: item.category, expected: item.expected,
      predicted: parsed.verdict, correct: parsed.verdict === item.expected,
      milliseconds: Math.round(performance.now() - started),
      promptTokens: data.prompt_eval_count || 0, outputTokens: data.eval_count || 0,
      tokensPerSecond: data.eval_duration > 0
        ? Math.round((data.eval_count || 0) * 1e9 / data.eval_duration * 10) / 10 : null
    };
  } catch (error) {
    return { id: item.id, category: item.category, expected: item.expected,
      predicted: null, correct: false,
      milliseconds: Math.round(performance.now() - started),
      error: String(error?.message || error).slice(0, 240) };
  }
}

export async function runBenchmark(options, { fetchImpl = fetch, log = () => {} } = {}) {
  const rows = [];
  for (const [index, item] of RESEARCH_EVAL_CASES.slice(0, options.cases).entries()) {
    const variants = options.compare
      ? (index % 2 ? ['strict', 'compact'] : ['compact', 'strict'])
      : [options.variant];
    for (const variant of variants) {
      log('Benchmark ' + (index + 1) + '/' + options.cases + ': ' + item.id + ' / ' + variant);
      rows.push({ variant, ...await classifyCase(item, { model: options.model, variant, fetchImpl }) });
    }
  }
  const byVariant = Object.fromEntries(
    [...new Set(rows.map(row => row.variant))].map(variant => [
      variant, summarizeResearchEval(rows.filter(row => row.variant === variant))
    ])
  );
  return { model: options.model, context: 4096, temperature: 0, seed: 42,
    dataset: 'small-curated-synthetic-v1', casesPerVariant: options.cases,
    byVariant, rows };
}

async function main() {
  const options = benchmarkOptions(process.argv.slice(2));
  const result = await runBenchmark(options, { log: options.json ? () => {} : console.error });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const [name, metrics] of Object.entries(result.byVariant))
      console.log(name + ': ' + metrics.correct + '/' + metrics.total + ' corretos; falsos suportes ' +
        metrics.falseSupport + '; erros de execução ' + metrics.errors +
        '; latência média ' + metrics.averageMilliseconds + 'ms');
    for (const row of result.rows.filter(row => !row.correct))
      console.log('Falha: ' + row.id + ' (' + row.variant + ') esperado=' + row.expected +
        ' obtido=' + (row.predicted || 'erro: ' + row.error));
  }
  if (result.rows.every(row => row.predicted === null)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1].replaceAll('\\', '/')).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
