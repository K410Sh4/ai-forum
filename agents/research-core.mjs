import { createHash } from 'node:crypto';

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function xmlText(input = '') {
  return String(input).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (full, key) => {
      if (key[0] === '#') {
        const code = key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      }
      return entities[key.toLowerCase()] ?? full;
    }).replace(/\s+/g, ' ').trim();
}
const tag = (xml, name) => xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i'))?.[1] || '';
function linkFrom(block, isAtom) {
  if (isAtom) {
    const matches = [...block.matchAll(/<link\b([^>]*?)\/?\s*>/gi)];
    const selected = matches.find(m => /rel\s*=\s*["']alternate["']/i.test(m[1])) || matches[0];
    return selected?.[1]?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] || '';
  }
  return xmlText(tag(block, 'link'));
}
export function readFeed(xml, feedUrl, { clock = Date.now(), maxAgeDays = 14 } = {}) {
  if (typeof xml !== 'string' || xml.length > 1_000_000) throw Error('Invalid RSS/Atom size');
  const isAtom = /<feed\b/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry\b[^>]*>[\s\S]*?<\/entry>/gi : /<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  const output = [];
  for (const entry of blocks.slice(0, 45)) {
    const title = xmlText(tag(entry, 'title')).slice(0, 190);
    const summary = xmlText(tag(entry, 'description') || tag(entry, 'summary') || tag(entry, 'content')).slice(0, 950);
    const date = new Date(xmlText(tag(entry, 'pubDate') || tag(entry, 'published') || tag(entry, 'updated')));
    const rawLink = xmlText(linkFrom(entry, isAtom));
    let link;
    try {
      link = new URL(rawLink, feedUrl);
      if (link.protocol !== 'https:' || link.username || link.password || link.hostname === 'localhost') continue;
      link.hash = '';
      for (const k of [...link.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(k)) link.searchParams.delete(k);
    } catch { continue; }
    if (!title || !summary || !Number.isFinite(date.valueOf())) continue;
    if (clock - date.getTime() > maxAgeDays * 86400000 || date.getTime() > clock + 86400000) continue;
    output.push({ title, summary, url: link.href, host: link.hostname.toLowerCase(), publishedAt: date.toISOString() });
  }
  return output;
}
export function chooseArticles(articles, seen = [], { count = 5, minHosts = 2 } = {}) {
  const seenSet = new Set(seen);
  const unique = new Map();
  for (const item of articles.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))) {
    if (!seenSet.has(item.url) && !unique.has(item.url)) unique.set(item.url, item);
  }
  const list = [...unique.values()].slice(0, Math.min(12, count * 3));
  const hosts = new Set(list.map(item => item.host));
  if (list.length < 2 || hosts.size < minHosts) return [];
  const selected = [], selectedHosts = new Set();
  for (const article of list) {
    if (!selectedHosts.has(article.host)) { selected.push(article); selectedHosts.add(article.host); }
    if (selectedHosts.size >= minHosts) break;
  }
  for (const article of list) {
    if (selected.length === count) break;
    if (!selected.includes(article)) selected.push(article);
  }
  return selected.map((article, i) => ({ ...article, id: 'S' + (i + 1) }));
}
export function composePost(topic, draft, sources) {
  const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max).replace(/https?:\/\/\S+/gi, '[link omitido]') : '';
  const title = clean(draft.title, 115);
  const overview = clean(draft.overview, 700);
  const uncertainty = clean(draft.uncertainties, 310);
  const viewpoints = Array.isArray(draft.perspectives) ? draft.perspectives.slice(0, 3) : [];
  const questions = Array.isArray(draft.questions) ? draft.questions.slice(0, 2).map(x => clean(x, 160)).filter(Boolean) : [];
  const ids = Array.isArray(draft.sourceIds) ? [...new Set(draft.sourceIds)] : [];
  if (title.length < 12 || overview.length < 160 || uncertainty.length < 20 || viewpoints.length < 2 || questions.length < 2) throw Error('Draft incomplete: manual review needed');
  if (ids.length < 2 || ids.some(id => !sources.some(s => s.id === id))) throw Error('Draft must cite at least two collected sources');
  const views = viewpoints.map((v, i) => {
    const label = clean(v?.label, 48), argument = clean(v?.argument, 250), caveat = clean(v?.caveat, 155);
    if (!label || argument.length < 35 || caveat.length < 15) throw Error('Viewpoint lacks argument or limitation');
    return (i + 1) + '. ' + label + ': ' + argument + ' (Limite: ' + caveat + ')';
  }).join('\n');
  const refs = sources.filter(s => ids.includes(s.id)).map(s => '[' + s.id + '] ' + s.title.slice(0, 90) + ' — ' + s.url + ' (' + s.publishedAt.slice(0, 10) + ')').join('\n');
  const content = 'Pesquisa assistida por IA local (' + topic.label + '). Fontes: feeds RSS/Atom, não uma verificação independente de cada alegação.\n\nSÍNTESE\n' + overview + '\n\nPERSPECTIVAS PARA DEBATE (geradas pelo mesmo modelo, não por agentes independentes)\n' + views + '\n\nINCERTEZAS\n' + uncertainty + '\n\nPERGUNTAS ABERTAS\n' + questions.map(x => '• ' + x).join('\n') + '\n\nFONTES CONSULTADAS\n' + refs;
  if (content.length > 3000) throw Error('Draft exceeds forum limit; shorten the input');
  return { title, content, tags: [topic.tag, 'pesquisa'].filter(Boolean).slice(0, 3) };
}
export function sourceFingerprint(sources) {
  return createHash('sha256').update(sources.map(s => s.url).sort().join('\n')).digest('hex');
}
