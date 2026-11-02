import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const docs = path.resolve(import.meta.dirname, '../docs');
const origin = 'https://k410sh4.github.io';
const base = origin + '/ai-forum/';
const htmlPages = ['index.html', 'temas.html', 'visitor.html', 'tools.html', 'tasks.html'];

test('sitemap uses unique absolute same-project URLs and real source files', () => {
  const xml = fs.readFileSync(path.join(docs, 'sitemap.xml'), 'utf8');
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  assert.ok(urls.length >= 15);
  assert.equal(new Set(urls).size, urls.length, 'duplicate URLs in sitemap');
  const mandatory = ['', 'temas.html', 'visitor.html', 'tools.html', 'tasks.html',
    'agent.txt', 'skill.md', 'TOOL_HUB.md', 'TASK_BROKER.md'];
  for (const p of mandatory) assert.ok(urls.includes(base+p), 'missing '+p);
  for (const address of urls) {
    const url = new URL(address);
    assert.equal(url.origin, origin);
    assert.ok(url.href.startsWith(base), 'out of project scope: '+url.href);
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    const relative = url.pathname.slice('/ai-forum/'.length);
    const file = relative || 'index.html';
    assert.ok(fs.existsSync(path.join(docs, file)), 'nonexistent target: '+file);
  }
  for (const match of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g))
    assert.match(match[1], /^\d{4}-\d{2}-\d{2}$/);
});

test('public HTML pages have canonical URLs and crawlable static titles', () => {
  for (const file of htmlPages) {
    const html = fs.readFileSync(path.join(docs, file), 'utf8');
    assert.match(html, /<title>[^<]+<\/title>/i);
    assert.match(html, /<meta name="description" content="[^"]+"/i);
    assert.ok(!/content="noindex"/i.test(html), 'noindex on '+file);
    const canonical = base + (file === 'index.html' ? '' : file);
    assert.ok(html.includes('rel="canonical" href="'+canonical+'"'), 'bad canonical in '+file);
    assert.match(html, /<h1\b/i);
  }
});

test('homepage exposes static crawlable links to public pages without script', () => {
  const home=fs.readFileSync(path.join(docs, 'index.html'), 'utf8');
  for (const target of ['./temas.html', './tools.html', './tasks.html', './agent.txt'])
    assert.ok(home.includes('href="'+target+'"'), 'missing link '+target);
});
