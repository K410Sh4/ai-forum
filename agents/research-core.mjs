import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const RESEARCH_VERSION = '2.2.0';
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
export function validateCard(card, source, { spans = [], requireSelection = false } = {}) {
  const summary = prose(card.summary, 35, 380, 'source summary');
  if (!Array.isArray(card.facts) || !card.facts.length || card.facts.length > 3) throw Error('Source card needs 1-3 supported facts');
  const facts = card.facts.map(f => {
    const statement = prose(f.statement, requireSelection ? 25 : 20, requireSelection ? 180 : 220, 'fact');
    const selected = spans.find(span => span.id === f.evidenceId);
    if (requireSelection && !selected) throw Error('Select an existing evidenceId from the supplied source spans');
    const quote = normalized(selected ? selected.text : f.quote || '');
    if (quote.length < 15 || quote.length > (selected ? 300 : 260) || !normalized(source.evidence || source.summary).toLowerCase().includes(quote.toLowerCase())) throw Error('Evidence quote was not found in the collected source');
    const numbers = value => (value.match(/\d+(?:[.,]\d+)?/g) || []).map(n => n.replace(',', '.'));
    if (numbers(statement).some(n => !numbers(quote).includes(n))) throw Error('Numeric fact is absent from its evidence quote');
    return { statement, quote, ...(selected ? { evidenceId: selected.id } : {}) };
  });
  return { sourceId: source.id, summary, facts, limitations: prose(card.limitations, 15, 220, 'source limitation') };
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
export const REVIEW_KINDS = ['unsupported-claim', 'contradiction', 'hypothesis-as-fact', 'false-consensus', 'false-independence', 'missing-detail', 'style'];
export function reviewMaterial(message) {
  if (typeof message?.content !== 'string') throw Error('Review requires a rendered message');
  const body = message.content.split(/\n\n(?:FONTES CONSULTADAS|Fontes:)\n/)[0];
  return [message.title, ...body.split(/\n\n+/)].filter(value => typeof value === 'string' && value.trim()).map((value, index) => ({ id: 'C' + (index + 1), text: value.trim() }));
}
export function validateReview(value, material) {
  if (!Array.isArray(value?.findings) || value.findings.length > 3) throw Error('Review needs at most three classified findings');
  const findings = value.findings.map(finding => {
    if (!REVIEW_KINDS.includes(finding?.kind)) throw Error('Unknown review finding kind');
    const selected = material.find(part => part.id === finding.claimId);
    if (!selected) throw Error('Review finding must select an existing claimId from the evaluated text');
    return { kind: finding.kind, claimId: selected.id, quote: selected.text, reason: prose(finding.reason, 15, 180, 'review reason') };
  });
  const advisory = finding => ['missing-detail', 'style'].includes(finding.kind);
  const issues = findings.filter(finding => !advisory(finding)).map(finding => finding.kind + ' [' + finding.claimId + '] «' + normalized(finding.quote).slice(0, 200) + '»: ' + finding.reason);
  const suggestions = findings.filter(advisory).map(finding => '[' + finding.claimId + '] ' + finding.reason);
  return { approved: issues.length === 0, issues, suggestions, findings, note: prose(value.note, 10, 180, 'review note') };
}
function references(sources) { return sources.map(s => '[' + s.id + '] ' + s.title.slice(0, 65) + ' — ' + s.url + ' (' + s.publishedAt.slice(0, 10) + ')').join('\n'); }
export function composePost(topic, draft, sources) {
  const title = prose(draft.title, 12, 115, 'title');
  const overview = prose(draft.overview, 160, 550, 'overview');
  const uncertainty = prose(draft.uncertainties, 20, 260, 'uncertainties');
  if (!Array.isArray(draft.perspectives) || draft.perspectives.length < 2 || draft.perspectives.length > 3 || !Array.isArray(draft.questions) || draft.questions.length !== 2) throw Error('Draft needs 2-3 perspectives and two questions');
  const selected = citedSources(draft.sourceIds, sources, 2); requireDiversity(selected);
  const views = draft.perspectives.map((v, i) => (i + 1) + '. ' + prose(v.label, 2, 40) + ': ' + prose(v.argument, 35, 220) + ' (Limite: ' + prose(v.caveat, 15, 130) + ')').join('\n');
  const questions = draft.questions.map(x => '• ' + prose(x, 8, 120)).join('\n');
  const findings = (draft.findings || []).map(f => {
    citedSources(f.sourceIds, selected);
    return '• ' + prose(f.text, 25, 200) + ' [' + f.sourceIds.join(', ') + ']';
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
    return prose(p.text, 60, 500, 'section paragraph') + ' [' + p.sourceIds.join(', ') + ']';
  });
  const selected = sources.filter(s => used.has(s.id)); requireDiversity(selected);
  const content = heading + '\n\n' + paragraphs.join('\n\n') + '\n\nLimitações: ' + prose(section.limitations, 25, 250) + '\n\nFontes:\n' + references(selected);
  if (content.length > 2900) throw Error('Section exceeds the reply budget');
  return { content };
}
export function payloadHash(draft) { const { hash, ...payload } = draft; return digest(payload); }
export function validateDraft(draft, { api, clock = Date.now(), maxAgeHours = 24, maxSourceAgeDays = 14 } = {}) {
  if (draft?.schemaVersion !== 2 || draft.hash !== payloadHash(draft) || !/^[a-f0-9]{64}$/.test(draft.hash) || !/^[a-f0-9]{24}$/.test(draft.id)) throw Error('Draft hash or format is invalid');
  if (draft.api !== api || draft.policyVersion !== POLICY_VERSION || draft.status !== 'ready' || draft.review?.approved !== true) throw Error('Draft is not approved for this API/policy');
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
  return draft;
}
export function similarTitle(a, b) {
  const words = value => new Set(normalized(value).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 3));
  const left = words(a), right = words(b), union = new Set([...left, ...right]);
  return union.size > 0 && [...left].filter(x => right.has(x)).length / union.size >= 0.85;
}
