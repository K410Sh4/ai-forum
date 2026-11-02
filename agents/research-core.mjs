import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { assertNumbersFromEvidence } from './research-numbers.mjs';

export const RESEARCH_VERSION = '3.1.0';
export const POLICY_VERSION = '2026-11-01';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const normalized = value => String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function xmlText(input = '') {
  let value = String(input).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  for (let pass = 0; pass < 2; pass++) {
    value = value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (full, key) => {
      if (key[0] !== '#') return entities[key.toLowerCase()] ?? full;
      const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
    });
  }
  return normalized(value.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' '));
}
const tag = (xml, name) => xml.match(new RegExp('<' + escapeRE(name) + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + escapeRE(name) + '\\s*>', 'i'))?.[1] || '';
const attr = (xml, name) => xml.match(new RegExp('\\b' + escapeRE(name) + '\\s*=\\s*["\u0027]([^"\u0027]*)["\u0027]', 'i'))?.[1] || '';
export function publicURL(value, base) {
  if (String(value).length > 2048) throw Error('URL exceeds 2048 characters');
  const url = new URL(value, base);
  const host = url.hostname.toLowerCase();
  if (url.href.length > 2048) throw Error('URL exceeds 2048 characters');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /(^|\.)(localhost|local|internal|lan)$/.test(host)) throw Error('A public HTTPS URL without credentials or custom port is required');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  return url;
}
export function publisherId(host, publishers = []) {
  return publishers.find(p => p.hosts.includes(host.toLowerCase()))?.id || host.toLowerCase();
}
export function parseFeed(xml, feedUrl, { clock = Date.now(), maxAgeDays = 14, publishers = [] } = {}) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1_000_000 || !/<(?:rss|rdf:RDF|(?:\w+:)?feed)\b/i.test(xml)) throw Error('Expected RSS/Atom XML (up to 1 MB)');
  const isAtom = /<(?:\w+:)?feed\b/i.test(xml);
  const blocks = xml.match(isAtom ? /<(?:\w+:)?entry\b[^>]*>[\s\S]*?<\/(?:\w+:)?entry\s*>/gi : /<item\b[^>]*>[\s\S]*?<\/item\s*>/gi) || [];
  const articles = [], rejected = { missingText: 0, invalidDate: 0, stale: 0, future: 0, invalidLink: 0 };
  for (const block of blocks.slice(0, 100)) {
    const title = xmlText(tag(block, 'title') || tag(block, 'atom:title')).slice(0, 190);
    const summary = xmlText(tag(block, 'description') || tag(block, 'content:encoded') || tag(block, 'summary') || tag(block, 'atom:summary') || tag(block, 'content') || tag(block, 'atom:content')).slice(0, 5000);
    if (!title || !summary) { rejected.missingText++; continue; }
    const dates = ['pubDate', 'dc:date', 'published', 'atom:published', 'updated', 'atom:updated'].map(n => Date.parse(xmlText(tag(block, n))));
    const date = dates.find(Number.isFinite);
    if (date === undefined) { rejected.invalidDate++; continue; }
    if (clock - date > maxAgeDays * 86400000) { rejected.stale++; continue; }
    if (date > clock + 300000) { rejected.future++; continue; }
    let rawLink = tag(block, 'link');
    if (isAtom) {
      const links = [...block.matchAll(/<(?:atom:)?link\b([^>]*?)\/?\s*>/gi)].map(m => m[1]);
      rawLink = attr(links.find(l => attr(l, 'rel') === 'alternate') || links.find(l => !attr(l, 'rel')) || '', 'href');
    }
    let url;
    try { if (!rawLink.trim()) throw Error(); url = publicURL(xmlText(rawLink), feedUrl); }
    catch { rejected.invalidLink++; continue; }
    const article = { title, summary, url: url.href, host: url.hostname.toLowerCase(), publisherId: publisherId(new URL(feedUrl).hostname, publishers), articlePublisherId: publisherId(url.hostname, publishers), publishedAt: new Date(date).toISOString(), fetchedAt: new Date(clock).toISOString(), feedUrl };
    article.contentHash = digest(article.summary);
    articles.push(article);
  }
  return { articles, diagnostics: { total: blocks.length, accepted: articles.length, rejected } };
}
export const readFeed = (xml, url, options) => parseFeed(xml, url, options).articles;
export function chooseArticles(articles, seen = [], { count = 4, minHosts = 2 } = {}) {
  const unique = new Map(), ignored = new Set(seen);
  for (const item of [...articles].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) if (!ignored.has(item.url) && !unique.has(item.url)) unique.set(item.url, item);
  const list = [...unique.values()], selected = [], publishers = new Set();
  if (new Set(list.map(a => a.publisherId || a.host)).size < minHosts || count < minHosts) return [];
  for (const item of list) {
    const publisher = item.publisherId || item.host;
    if (!publishers.has(publisher)) { selected.push(item); publishers.add(publisher); }
    if (publishers.size >= minHosts) break;
  }
  for (const item of list) { if (selected.length >= count) break; if (!selected.includes(item)) selected.push(item); }
  return selected.map((item, i) => ({ ...item, id: 'S' + (i + 1) }));
}
export function sourceFingerprint(sources, topicId = '') { return digest([topicId, ...sources.map(s => s.url + ':' + (s.contentHash || '')).sort()]); }
export function citedSources(ids, sources, minimum = 1) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length || ids.length < minimum || ids.some(id => !sources.some(s => s.id === id))) throw Error('Draft must cite valid collected source IDs');
  return sources.filter(s => ids.includes(s.id));
}
export function requireDiversity(sources) {
  if (new Set(sources.map(s => s.publisherId || s.host)).size < 2) throw Error('At least two distinct publishers must be cited in the final text');
}
export function prose(value, min, max, name = 'text') {
  if (typeof value !== 'string' || normalized(value).length < min || normalized(value).length > max || /https?:\/\//i.test(value) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw Error('Invalid ' + name + ' (length, URL or control character)');
  return normalized(value);
}
export function sentence(value, min, max, name = 'sentence') {
  const result = prose(value, min, max, name);
  if (/[\uFFFD\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(result)) throw Error('Unexpected characters in Portuguese ' + name + '; rewrite the complete sentence');
  if (!/[.!?][”"')]*$/.test(result) || /(?:\.{2,}|…)[”"')]*$/.test(result)) throw Error('Incomplete ' + name + '; rewrite a complete sentence with final punctuation, without cutting words');
  let balance = 0;
  for (const character of result) { if (character === '(') balance++; if (character === ')' && --balance < 0) throw Error('Unbalanced parentheses in ' + name); }
  if (balance) throw Error('Unbalanced parentheses in ' + name);
  return result;
}
export function evidenceSpans(value) {
  const original = normalized(value);
  let collected = original.slice(0, 4000);
  if (original.length > collected.length && collected.lastIndexOf(' ') > 3800) collected = collected.slice(0, collected.lastIndexOf(' '));
  if (collected.length < 15) return [];
  const spans = []; let start = 0;
  while (start < collected.length) {
    let end = Math.min(start + 240, collected.length);
    if (end < collected.length) {
      const prefix = collected.slice(start, end);
      const boundary = [...prefix.matchAll(/[.!?][”"']?\s+/g)].at(-1);
      const space = collected.lastIndexOf(' ', end);
      if (boundary && boundary.index > 60) end = start + boundary.index + boundary[0].length;
      else if (space > start + 100) end = space;
      if (collected.length - end < 15) end = collected.length;
      if (end < collected.length && /[\uD800-\uDBFF]/.test(collected[end - 1])) end--;
    }
    const text = collected.slice(start, end).trim();
    if (text) spans.push({ id: 'E' + (spans.length + 1), text });
    start = end; while (collected[start] === ' ') start++;
  }
  return spans;
}
// These guards catch *known* unsupported leaps, not every possible
// hallucination. The reviewer still needs source-level human verification.
const foldPT = value => normalized(value).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const anchoredDomains = [
  { label: 'educational', claim: /\b(?:educacional|educacao|escolar|ensino|pedagogic[ao])\b/u, evidence: /\b(?:educat\w*|school\w*|teach\w*|pedagog\w*|classroom\w*|student\w*|ensino|educacao|escolar)\b/u },
  { label: 'medical', claim: /\b(?:medic[ao]|saude|(?:hospital(?:ar)?|hospitais)|clinico|clinica)\b/u, evidence: /\b(?:medic\w*|health\w*|hospital\w*|clinical|clinico|clinica|saude)\b/u }
];
export function validateSourceClaimGrounding(statement, quote) {
  const claim = foldPT(statement), evidence = foldPT(quote);
  if (/\balunis\b/u.test(claim)) throw Error('Factual grounding: invalid Portuguese inflection in source fact');
  if (/\btransmite-se\b/u.test(claim) && /\btransfer\w*\b/u.test(evidence) && !/\btransmi\w*\b/u.test(evidence))
    throw Error('Factual grounding: transfer learning was inaccurately described as transmission');
  for (const domain of anchoredDomains) {
    if (domain.claim.test(claim) && !domain.evidence.test(evidence)) {
      throw Error('Factual grounding: ' + domain.label + ' claim lacks a matching term in the selected evidence quote');
    }
  }  if (/\b(?:significativ[oa]s?|revolucionari[oa]s?)\b/u.test(claim) &&
      !/\b(?:significan\w*|substantial\w*|significativ\w*|considerab\w*|revolutionary)\b/u.test(evidence))
    throw Error('Factual grounding: significance is not explicitly supported by the selected source quote');
}
// Negative claims about the *absence* of empirical validation are not
// established merely because an RSS excerpt does not mention a result.
const highRiskClaims = [
  { pattern: /\b(?:avanc\w*|contribui\w*|impact\w*|inovac\w*|benefici\w*|melhor\w*)\s+significativ\w*\b/u, reason: 'unsubstantiated significance' },
  { pattern: /\b(?:revolucion\w*|transformador\w*|transformar\s+(?:radicalmente|completamente))\b/u, reason: 'speculative impact' },
  { pattern: /\binovacao\s+educacional\b/u, reason: 'educational leap' },
  { pattern: /\b(?:eficacia|desempenho|aplicacao|modelo)\b.{0,120}\b(?:ainda\s+(?:precisa|necessita)\s+(?:ser\s+)?validad\w*|nao\s+(?:foi|esta|esta\s+sendo)\s+validad\w*)\b/u, reason: 'unqualified lack-of-validation claim' },
  { pattern: /\b(?:nao\s+(?:foi|esta)\s+validad\w*|ainda\s+nao\s+foi\s+(?:testad|avaliad)\w*)\b/u, reason: 'unqualified lack-of-validation claim' }
];
export function validateEditorialGrounding(opening) {
  const fields = [
    ['overview', opening.overview],
    ['uncertainties', opening.uncertainties],
    ...(Array.isArray(opening.perspectives) ? opening.perspectives.flatMap((p, index) => [
      ['perspectives[' + index + '].argument', p.argument],
      ['perspectives[' + index + '].caveat', p.caveat]
    ]) : [])
  ];
  for (const [field, value] of fields) {
    if (typeof value !== 'string') continue; // composePost validates structure
    const text = foldPT(value);
    for (const risk of highRiskClaims) {
      if (risk.pattern.test(text)) throw Error('Factual grounding: ' + risk.reason + ' in ' + field + '; rewrite with precise, source-limited statements');
    }
    if (/\balunis\b/u.test(text)) throw Error('Factual grounding: invalid Portuguese inflection in ' + field);
    if (/\b(?:a|uma|o)\s+benefica\b/u.test(text)) throw Error('Factual grounding: malformed use of benéfica in ' + field);
  }
  return { passed: true, independent: false, scope: 'known unsupported inferences and evidence-domain anchors', humanVerificationRequired: true };
}

export function validateCard(card, source, { spans = [], requireSelection = false } = {}) {
  let summary, summaryMode = 'model';
  try { summary = sentence(card.summary, 35, 380, 'source summary'); }
  catch (error) {
    // Only a visibly unfinished summary is recoverable. Bad lengths, control
    // characters, URLs, unsupported facts and missing quotes must still fail.
    if (!error.message.startsWith('Incomplete source summary;')) throw error;
    summaryMode = 'supported-fact-fallback';
  }
  if (!Array.isArray(card.facts) || !card.facts.length || card.facts.length > 3) throw Error('Source card needs 1-3 supported facts');
  const facts = card.facts.map(f => {
    const statement = sentence(f.statement, requireSelection ? 25 : 20, requireSelection ? 180 : 220, 'fact');
    const selected = spans.find(span => span.id === f.evidenceId);
    if (requireSelection && !selected) throw Error('Select an existing evidenceId from the supplied source spans');
    const quote = normalized(selected ? selected.text : f.quote || '');
    if (quote.length < 15 || quote.length > (selected ? 300 : 260) || !normalized(source.evidence || source.summary).toLowerCase().includes(quote.toLowerCase())) throw Error('Evidence quote was not found in the collected source');
    assertNumbersFromEvidence(statement, quote);
    validateSourceClaimGrounding(statement, quote);
    return { statement, quote, ...(selected ? { evidenceId: selected.id } : {}) };
  });
  const limitations = sentence(card.limitations, 15, 220, 'source limitation');
  if (summaryMode === 'supported-fact-fallback') {
    // This sentence uses only the first validated factual statement, whose
    // evidenceId, literal quote and numeric details were checked above.
    summary = sentence('Achado relatado na fonte consultada: ' + facts[0].statement, 35, 380, 'source summary');
  }
  return { sourceId: source.id, summary, summaryMode, facts, limitations };
}
export function openingEvidence(cards, sources) {
  const selected = [], publishers = new Set();
  for (const card of cards) {
    const [source] = citedSources([card.sourceId], sources);
    const publisher = source.publisherId || source.host;
    if (!publishers.has(publisher)) { selected.push(card); publishers.add(publisher); }
    if (publishers.size === 2) break;
  }
  for (const card of cards) { if (selected.length === 3) break; if (!selected.includes(card)) selected.push(card); }
  const sourceIds = selected.map(card => card.sourceId);
  requireDiversity(citedSources(sourceIds, sources, 2));
  return { sourceIds, findings: selected.map(card => ({ text: prose(card.facts?.[0]?.statement, 25, 180, 'supported finding'), sourceIds: [card.sourceId] })) };
}
// Short overview fallback uses ONLY previously selected and validated source
// facts, not a model's invalid summary. It still goes through composePost(),
// all factual guards and the mandatory independent-of-fallback Qwen review.
// It does NOT guarantee factual accuracy of the source-card paraphrases.
export function overviewFromSupportedFacts(cards, sourceIds) {
  if (!Array.isArray(cards) || !Array.isArray(sourceIds) || sourceIds.length < 2 ||
      new Set(sourceIds).size !== sourceIds.length) throw Error('Short overview requires at least two distinct reviewed source IDs');
  const selected = sourceIds.slice(0, 2).map(id => {
    const card = cards.find(item => item.sourceId === id);
    if (!card || !Array.isArray(card.facts) || !card.facts[0]) throw Error('Missing reviewed source fact for short overview');
    const fact = card.facts[0];
    if (typeof fact.quote !== 'string') throw Error('Short overview requires an evidence-backed source fact');
    validateSourceClaimGrounding(fact.statement, fact.quote);
    return { id, text: sentence(fact.statement, 25, 180, 'supported fact') };
  });
  const result = 'A fonte ' + selected[0].id + ' relata: ' + selected[0].text +
    ' A fonte ' + selected[1].id + ' relata: ' + selected[1].text +
    ' As notícias são apresentadas separadamente, sem pressupor confirmação recíproca.';
  return sentence(result, 160, 550, 'overview');
}

export const REVIEW_KINDS = ['unsupported-claim', 'contradiction', 'hypothesis-as-fact', 'false-consensus', 'false-independence', 'incomplete-text', 'missing-detail', 'style'];
export function reviewMaterial(message) {
  if (typeof message?.content !== 'string') throw Error('Review requires a rendered message');
  const body = message.content.split(/\n\n(?:FONTES CONSULTADAS|Fontes:)\n/)[0];
  const sections = body.split(/\n\n+/);
  // composePost() inserts this fixed disclosure. It is neither an empirical
  // claim nor model-authored prose, so asking the same model to fact-check it
  // previously produced false-independence errors (2026-11-01 incident).
  // Match the complete boilerplate, only in its known first position. If a
  // participant changes a word, the altered content stays in the review.
  const fixedDisclosure = /^Pesquisa assistida por IA local — [^\r\n]{5,120}\. Perspectivas do mesmo modelo; revisão automática não comprova os fatos\.$/;
  if (sections.length && fixedDisclosure.test(sections[0].trim())) sections.shift();
  // A whole SÍNTESE paragraph used to share one claimId, forcing the critic
  // to flag 3 unrelated assertions under C2. Review each complete sentence.
  // Preserve all original words and section order; never silence a claim.
  const claims = sections.flatMap(section => {
    const perspective = /^PERSPECTIVAS PARA DEBATE\n([\s\S]+)$/u.exec(section.trim());
    if (perspective) {
      const entries = perspective[1].split(/\n(?=\d+\.\s)/u).map(value => value.trim()).filter(Boolean);
      return entries.length <= 1 ? [section] : entries.map((entry, index) => (index === 0 ? 'PERSPECTIVAS PARA DEBATE\n' : '') + entry);
    }
    const match = /^SÍNTESE\n([\s\S]+)$/u.exec(section.trim());
    if (!match) return [section];
    const sentences = match[1].split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}“"'])/u).map(value => value.trim()).filter(Boolean);
    return sentences.length <= 1 ? [section] : sentences.map((sentence, index) => (index === 0 ? 'SÍNTESE\n' : '') + sentence);
  });
  return [message.title, ...claims].filter(value => typeof value === 'string' && value.trim()).map((value, index) => ({ id: 'C' + (index + 1), text: value.trim() }));
}
// When the critic calls a fully punctuated perspective "incomplete" only
// because it wants more detail, this is an advisory, not a missing sentence.
// Restrict this narrowly to the generated perspective list; do not reinterpret
// unsupported claims, genuine truncation, contradictions or other categories.
function perspectiveIsSyntacticallyComplete(text) {
  if (!/^(?:PERSPECTIVAS PARA DEBATE\n)?\d+\.\s/u.test(text)) return false;
  const lines = text.replace(/^PERSPECTIVAS PARA DEBATE\n/u, '').split('\n').filter(Boolean);
  return lines.every(line => {
    if (!/^\d+\.\s.+\(Limite: .+\)$/u.test(line)) return false;
    const argument = line.slice(line.indexOf(': ') + 2, line.lastIndexOf(' (Limite: '));
    const caveat = line.slice(line.lastIndexOf(' (Limite: ') + 9, -1);
    return /[.!?][”"']*$/u.test(argument) && /[.!?][”"']*$/u.test(caveat) &&
      !/[\uFFFD\u2026]/u.test(line) && !/\.{2,}/u.test(line) &&
      (line.match(/\(/g) || []).length === (line.match(/\)/g) || []).length;
  });
}
function detailOnlyMisclassification(finding, text, reason) {
  return finding.kind === 'incomplete-text' && perspectiveIsSyntacticallyComplete(text) &&
    /(?:falta(?:m)?\s+(?:de\s+)?(?:detalhes|detalhamento|contexto)|n[aã]o\s+(?:detalha|explica|descreve)|sem\s+(?:detalhes|contexto))/iu.test(reason) &&
    !/(?:interrompid|cortad|truncad|palavra\s+incompleta|sem\s+pontua|n[aã]o\s+(?:termina|conclui)|idioma\s+mistur|sem\s+sentido|ileg[ií]vel)/iu.test(reason);
}
// Review explanations are local diagnostic metadata, not publication prose.
// Allow complete critical explanations (including quoted excerpts) up to 500
// characters rather than losing all findings when Qwen exceeds 180.
// prose() continues to reject URLs, control characters and invalid types.
export function validateReview(value, material) {
  if (!Array.isArray(value?.findings) || value.findings.length > 3) throw Error('Review needs at most three classified findings');
  const findings = value.findings.map(finding => {
    if (!REVIEW_KINDS.includes(finding?.kind)) throw Error('Unknown review finding kind');
    const selected = material.find(part => part.id === finding.claimId);
    if (!selected) throw Error('Review finding must select an existing claimId from the evaluated text');
    const reason = prose(finding.reason, 15, 500, 'review reason');
    if (detailOnlyMisclassification(finding, selected.text, reason)) return {
      kind: 'missing-detail', originalKind: finding.kind, classification: 'complete-perspective-needs-detail',
      claimId: selected.id, quote: selected.text, reason
    };
    return { kind: finding.kind, claimId: selected.id, quote: selected.text, reason };
  });
  const advisory = finding => ['missing-detail', 'style'].includes(finding.kind);
  const issues = findings.filter(finding => !advisory(finding)).map(finding => finding.kind + ' [' + finding.claimId + '] «' + normalized(finding.quote).slice(0, 200) + '»: ' + finding.reason);
  const suggestions = findings.filter(advisory).map(finding => '[' + finding.claimId + '] ' + finding.reason);
  const reclassified = findings.filter(finding => finding.classification).map(finding => ({
    claimId: finding.claimId, from: finding.originalKind, to: finding.kind,
    classification: finding.classification, reason: finding.reason
  }));
  return { approved: issues.length === 0, issues, suggestions, findings, reclassified,
    note: prose(value.note, 10, 500, 'review note') };
}
function references(sources) { return sources.map(s => '[' + s.id + '] ' + s.title.slice(0, 65) + ' — ' + s.url + ' (' + s.publishedAt.slice(0, 10) + ')').join('\n'); }
export function composePost(topic, draft, sources) {
  validateEditorialGrounding(draft);
  const title = prose(draft.title, 12, 115, 'title');
  const overview = sentence(draft.overview, 160, 550, 'overview');
  const uncertainty = sentence(draft.uncertainties, 20, 260, 'uncertainties');
  if (!Array.isArray(draft.perspectives) || draft.perspectives.length < 2 || draft.perspectives.length > 3 || !Array.isArray(draft.questions) || draft.questions.length !== 2) throw Error('Draft needs 2-3 perspectives and two questions');
  const selected = citedSources(draft.sourceIds, sources, 2); requireDiversity(selected);
  const views = draft.perspectives.map((v, i) => (i + 1) + '. ' + prose(v.label, 2, 40) + ': ' + sentence(v.argument, 35, 220, 'perspective') + ' (Limite: ' + sentence(v.caveat, 15, 130, 'perspective limit') + ')').join('\n');
  const questions = draft.questions.map(x => '• ' + sentence(x, 8, 120, 'question')).join('\n');
  const findings = (draft.findings || []).map(f => {
    citedSources(f.sourceIds, selected);
    return '• ' + sentence(f.text, 25, 200, 'finding') + ' [' + f.sourceIds.join(', ') + ']';
  });
  if (findings.length > 3) throw Error('At most three findings per opening post');
  const content = 'Pesquisa assistida por IA local — ' + topic.label + '. Perspectivas do mesmo modelo; revisão automática não comprova os fatos.\n\nSÍNTESE\n' + overview + (findings.length ? '\n\nEVIDÊNCIAS\n' + findings.join('\n') : '') + '\n\nPERSPECTIVAS PARA DEBATE\n' + views + '\n\nINCERTEZAS\n' + uncertainty + '\n\nPERGUNTAS ABERTAS\n' + questions + '\n\nFONTES CONSULTADAS\n' + references(selected);
  if (content.length > 2900) throw Error('Draft exceeds the opening-post budget; shorten it while retaining sources');
  return { title, content, tags: [topic.tag, 'pesquisa'] };
}
export function composeSection(section, sources) {
  const heading = prose(section.heading, 10, 100, 'section heading');
  if (!Array.isArray(section.paragraphs) || section.paragraphs.length < 2 || section.paragraphs.length > 4) throw Error('A section needs 2-4 paragraphs');
  const used = new Set();
  const paragraphs = section.paragraphs.map(p => {
    citedSources(p.sourceIds, sources).forEach(s => used.add(s.id));
    return sentence(p.text, 60, 500, 'section paragraph') + ' [' + p.sourceIds.join(', ') + ']';
  });
  const selected = sources.filter(s => used.has(s.id)); requireDiversity(selected);
  const content = heading + '\n\n' + paragraphs.join('\n\n') + '\n\nLimitações: ' + sentence(section.limitations, 25, 250, 'section limitation') + '\n\nFontes:\n' + references(selected);
  if (content.length > 2900) throw Error('Section exceeds the reply budget');
  return { content };
}
export function payloadHash(draft) { const { hash, ...payload } = draft; return digest(payload); }
export function stampMessages(post, replies, id, fingerprint) {
  return [post, ...replies].map((message, index, messages) => ({ ...message, content: message.content + '\n\nPesquisa ' + id + ' · parte ' + (index + 1) + '/' + messages.length + ' · ref ' + fingerprint.slice(0, 16) }));
}
export function validateDraft(draft, { api, clock = Date.now(), maxAgeHours = 24, maxSourceAgeDays = 14 } = {}) {
  if (![2, 3].includes(draft?.schemaVersion) || draft.hash !== payloadHash(draft) || !/^[a-f0-9]{64}$/.test(draft.hash) || !/^[a-f0-9]{24}$/.test(draft.id)) throw Error('Draft hash or format is invalid');
  if (draft.schemaVersion !== 3) throw Error('Draft predates complete-text validation; cancel any pending delivery of this draft, then generate a fresh preview');
  if (draft.api !== api || draft.policyVersion !== POLICY_VERSION || draft.status !== 'ready' || draft.review?.approved !== true) throw Error('Draft is not approved for this API/policy');
  if (draft.review?.factualGate?.passed !== true || draft.review.factualGate.independent !== false ||
      draft.review.factualGate.humanVerificationRequired !== true)
    throw Error('Draft predates factual grounding validation; generate a new preview before publishing');
  const created = Date.parse(draft.createdAt);
  if (!Number.isFinite(created) || created > clock + 300000 || clock - created > maxAgeHours * 3600000) throw Error('Draft expired; generate and review a fresh draft');
  if (!Array.isArray(draft.sources) || draft.sources.length > 4) throw Error('Invalid draft sources');
  requireDiversity(draft.sources);
  for (const source of draft.sources) {
    publicURL(source.url);
    const date = Date.parse(source.publishedAt);
    if (!Number.isFinite(date) || clock - date > maxSourceAgeDays * 86400000 || date > clock + 300000) throw Error('Draft sources are no longer fresh');
  }
  if (!draft.post || prose(draft.post.title, 5, 120).length < 5 || !Array.isArray(draft.replies) || draft.replies.length > 2) throw Error('Invalid draft messages');
  for (const message of [draft.post, ...draft.replies]) if (typeof message.content !== 'string' || message.content.length < 10 || message.content.length > 3000 || !message.content.includes('Pesquisa ' + draft.id)) throw Error('Invalid draft message or provenance marker');
  if (!draft.editorial?.opening || !Array.isArray(draft.editorial.sections) || draft.editorial.sections.length !== draft.replies.length) throw Error('Draft needs its validated editorial fields');
  if (!Array.isArray(draft.cards) || draft.cards.length < 2)
    throw Error('Draft needs source cards for factual grounding validation');
  for (const card of draft.cards) {
    const source = draft.sources.find(item => item.id === card.sourceId);
    if (!source || !Array.isArray(card.facts) || !card.facts.length || card.facts.length > 3)
      throw Error('Draft source cards must refer to selected sources');
    const spans = evidenceSpans(source.summary);
    for (const fact of card.facts) {
      // Revalidate the literal evidence at publication, not just the model's
      // summary or the signed hash. A self-consistent but invented quote must
      // never be accepted as evidence when publishing a stored JSON file.
      const selected = spans.find(span => span.id === fact.evidenceId);
      if (!selected || selected.text !== normalized(fact.quote))
        throw Error('Draft evidence quote no longer matches a selected source span');
      const checked = sentence(fact.statement, 25, 220, 'fact');
      assertNumbersFromEvidence(checked, selected.text, 'Draft numeric claim is absent from its original evidence span');
      validateSourceClaimGrounding(checked, selected.text);
    }
  }
  const expected = stampMessages(composePost(draft.theme, draft.editorial.opening, draft.sources), draft.editorial.sections.map(section => composeSection(section, draft.sources)), draft.id, draft.fingerprint);
  for (const [index, message] of [draft.post, ...draft.replies].entries()) {
    if (message.content !== expected[index].content || message.title !== expected[index].title || JSON.stringify(message.tags) !== JSON.stringify(expected[index].tags)) throw Error('Rendered draft differs from its validated editorial fields');
  }
  return draft;
}
export function similarTitle(a, b) {
  const words = value => new Set(normalized(value).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 3));
  const left = words(a), right = words(b), union = new Set([...left, ...right]);
  return union.size > 0 && [...left].filter(x => right.has(x)).length / union.size >= 0.85;
}
