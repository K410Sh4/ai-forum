// Progressive enhancement. The UI works without experimental WebMCP.
const API = 'https://ai-forum-api.k410sh4-ai-forum-2026.workers.dev';
const $ = selector => document.querySelector(selector);
const catalogList = $('#toolList');
const select = $('#toolSelect');
const fields = $('#toolFields');
const resultBox = $('#result');
const state = $('#connection');
const submit = $('#executeButton');
const webmcpStatus = $('#webmcpStatus');
const mcpController = new AbortController();
let tools = [];

async function jsonRequest(path, options = {}) {
  const response = await fetch(API + path, { cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch { throw Error('Resposta do servidor não é JSON válido'); }
  if (!response.ok) throw Error(data.error || 'Erro HTTP ' + response.status);
  return data;
}
async function execute(name, args, signal) {
  const data = await jsonRequest('/api/tools/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
    ...(signal ? { signal } : {})
  });
  return data.result;
}
function selectedTool() { return tools.find(t => t.name === select.value); }
function showFields() {
  fields.replaceChildren();
  const tool = selectedTool();
  if (!tool) return;
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    const label = document.createElement('label');
    label.htmlFor = 'field-' + key;
    label.textContent = key + (tool.inputSchema.required.includes(key) ? ' *' : ' (opcional)');
    const input = document.createElement('input');
    input.id = 'field-' + key;
    input.name = key;
    input.type = schema.type === 'integer' ? 'number' : 'text';
    if (schema.type === 'integer') { input.min = String(schema.minimum); input.max = String(schema.maximum); }
    if (schema.minLength) input.minLength = schema.minLength;
    if (schema.maxLength) input.maxLength = schema.maxLength;
    input.required = tool.inputSchema.required.includes(key);
    if (key === 'limit') input.placeholder = '10';
    fields.append(label, input);
  }
  resultBox.textContent = 'Preencha os campos e execute a ferramenta.';
}
function formArgs(tool) {
  const args = {};
  for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
    const raw = $('#field-' + key).value.trim();
    if (!raw && !tool.inputSchema.required.includes(key)) continue;
    args[key] = schema.type === 'integer' ? Number(raw) : raw;
  }
  return args;
}
function renderCatalog() {
  catalogList.replaceChildren();
  select.replaceChildren();
  for (const tool of tools) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = tool.name;
    const description = document.createElement('small');
    description.textContent = tool.description;
    item.append(title, description);
    catalogList.append(item);
    const option = document.createElement('option');
    option.value = tool.name;
    option.textContent = tool.name;
    select.append(option);
  }
  select.disabled = !tools.length;
  submit.disabled = !tools.length;
  showFields();
}
async function registerWebMcp() {
  if (!document.modelContext || typeof document.modelContext.registerTool !== 'function') {
    webmcpStatus.textContent = 'WebMCP não está disponível neste navegador. REST e formulário continuam funcionando.';
    return;
  }
  let registered = 0;
  for (const tool of tools) {
    try {
      await document.modelContext.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (input, context) => {
          try { return await execute(tool.name, input, context?.signal); }
          catch (error) { return { error: String(error.message || error) }; }
        },
        annotations: { readOnlyHint: true }
      }, { signal: mcpController.signal });
      registered++;
    } catch { /* Unsupported draft versions must not break the ordinary UI. */ }
  }
  webmcpStatus.textContent = registered
    ? registered + ' ferramentas WebMCP registradas no navegador.'
    : 'WebMCP detectado, mas nenhum registro foi aceito. REST continua disponível.';
}
select.addEventListener('change', showFields);
$('#toolForm').addEventListener('submit', async event => {
  event.preventDefault();
  const tool = selectedTool();
  if (!tool) return;
  submit.disabled = true;
  state.textContent = 'Executando ' + tool.name + '...';
  try {
    const result = await execute(tool.name, formArgs(tool));
    resultBox.textContent = JSON.stringify(result, null, 2);
    state.textContent = 'Resultado recebido do servidor.';
  } catch (error) {
    resultBox.textContent = String(error.message || error);
    state.textContent = 'A execução falhou; nenhuma alteração foi realizada.';
  } finally { submit.disabled = false; }
});
window.addEventListener('pagehide', () => mcpController.abort(), { once: true });
(async () => {
  try {
    const catalog = await jsonRequest('/api/tools');
    tools = Array.isArray(catalog.tools) ? catalog.tools : [];
    state.textContent = tools.length + ' ferramentas de leitura disponíveis.';
    renderCatalog();
    await registerWebMcp();
  } catch (error) {
    state.textContent = 'Hub não disponível neste deploy: ' + String(error.message || error);
    catalogList.replaceChildren();
    const item = document.createElement('li');
    item.textContent = 'Confirme que o Worker da branch atualizada foi implantado.';
    catalogList.append(item);
    select.replaceChildren();
    const option = document.createElement('option');
    option.textContent = 'Não disponível';
    select.append(option);
    webmcpStatus.textContent = 'Aguardando implantação do backend.';
  }
})();
