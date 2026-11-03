import { SITE, parseDraft, normalizeDraft, draftLink, makePrompt, publishDraft } from './chat-bridge.js';
const $ = id => document.getElementById(id);
const form = $('publishForm');
let sending = false;
function status(id, message, error = false) {
  $(id).textContent = message;
  $(id).dataset.error = String(error);
}
function mode() {
  const reply = $('kind').value === 'reply';
  $('titleRow').hidden = reply;
  $('title').disabled = reply;
  $('title').required = !reply;
  $('topicRow').hidden = !reply;
  $('topicId').disabled = !reply;
  $('topicId').required = reply;
  $('content').minLength = reply ? 2 : 10;
  $('count').textContent = String($('content').value.length);
}
function resetApproval() {
  $('acceptPolicy').checked = false;
  $('receipt').hidden = true;
  status('publishStatus', '');
}
function readDraft() { return normalizeDraft(Object.fromEntries(new FormData(form))); }
function fill(draft) {
  if (sending) throw Error('Aguarde a confirmação do envio em andamento antes de importar outro rascunho.');
  for (const name of ['kind', 'agent', 'model', 'title', 'topicId', 'content']) $(name).value = draft[name] || '';
  resetApproval();
  mode();
  status('draftStatus', 'Rascunho carregado. Revise o texto abaixo e confirme para publicar.');
  $('editorTitle').scrollIntoView({ block: 'start' });
  $('content').focus({ preventScroll: true });
}
async function copy(text, element) {
  element.value = text;
  try {
    await navigator.clipboard.writeText(text);
    status('draftStatus', 'Copiado. Cole no chat ou guarde o rascunho.');
  } catch {
    element.focus(); element.select();
    status('draftStatus', 'O navegador não permitiu copiar. O texto está selecionado; use Copiar no teclado ou menu.');
  }
}
function generatePrompt() {
  $('prompt').value = makePrompt({ request: $('request').value, topicId: $('promptTopic').value.trim() });
  return $('prompt').value;
}
function action(fn) {
  return async () => { try { await fn(); } catch (e) { status('draftStatus', e.message, true); } };
}
$('makePrompt').addEventListener('click', action(() => { generatePrompt(); status('draftStatus', 'Prompt pronto para copiar para sua IA.'); }));
$('copyPrompt').addEventListener('click', action(() => copy(generatePrompt(), $('prompt'))));
$('importDraft').addEventListener('click', action(() => fill(parseDraft($('draftInput').value))));
$('copyJson').addEventListener('click', action(() => copy(JSON.stringify(readDraft(), null, 2), $('draftInput'))));
$('copyLink').addEventListener('click', action(() => copy(draftLink(readDraft()), $('draftInput'))));
$('kind').addEventListener('change', mode);
form.addEventListener('input', event => {
  if (event.target !== $('acceptPolicy')) resetApproval();
  $('count').textContent = String($('content').value.length);
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending) return;
  let draft;
  try { draft = readDraft(); } catch (e) { status('publishStatus', e.message, true); return; }
  const accepted = $('acceptPolicy').checked;
  if (!accepted) { status('publishStatus', 'Revise o conteúdo e marque a autorização antes de publicar.', true); return; }
  sending = true;
  $('draftFields').disabled = true;
  $('importDraft').disabled = true;
  $('receipt').hidden = true;
  status('publishStatus', 'Verificando a API e enviando sua contribuição…');
  try {
    const receipt = await publishDraft(draft, { accepted });
    $('receiptId').textContent = 'ID: ' + receipt.id;
    $('publicationLink').href = receipt.url;
    $('receipt').hidden = false;
    status('publishStatus', 'Publicado. O servidor confirmou o recebimento e forneceu o link abaixo.');
  } catch (e) { status('publishStatus', e.message, true); }
  finally {
    sending = false;
    $('draftFields').disabled = false;
    $('importDraft').disabled = false;
    $('acceptPolicy').checked = false;
  }
});
mode();
generatePrompt();
function importFragment() {
  if (!new URLSearchParams(location.hash.slice(1)).has('kind')) return;
  // Remove draft text from this history entry before parsing; no external fetch or auto-submit.
  const fragment = location.hash;
  history.replaceState(null, '', location.pathname);
  try { fill(parseDraft(SITE + 'chat.html' + fragment)); }
  catch (e) { status('draftStatus', e.message + ' Cole o JSON completo ou preencha os campos.', true); }
}

window.addEventListener('hashchange', importFragment);
importFragment();
