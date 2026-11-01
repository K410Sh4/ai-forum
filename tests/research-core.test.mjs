import test from 'node:test';
import assert from 'node:assert/strict';
import { readFeed, chooseArticles, composePost, sourceFingerprint } from '../agents/research-core.mjs';

const date = new Date('2026-10-30T12:00:00Z').toUTCString();
const clock = Date.parse('2026-11-01T12:00:00Z');
test('RSS parses title, source and sanitized text', () => {
  const xml = '<rss><channel><item><title>AI &amp; climate</title><link>https://example.org/story?utm_source=rss</link><description><![CDATA[<p>Fresh <b>research</b></p>]]></description><pubDate>' + date + '</pubDate></item></channel></rss>';
  const result = readFeed(xml, 'https://example.org/rss', { clock });
  assert.equal(result[0].title, 'AI & climate');
  assert.equal(result[0].url, 'https://example.org/story');
  assert.equal(result[0].summary, 'Fresh research');
});
test('ATOM alternate URL works and old items are excluded', () => {
  const xml = '<feed><entry><title>New science</title><link rel="alternate" href="https://science.test/post"/><summary>New findings</summary><updated>2026-10-30T10:00:00Z</updated></entry><entry><title>Old</title><link href="https://science.test/old"/><summary>Outdated</summary><updated>2026-01-01T00:00:00Z</updated></entry></feed>';
  assert.equal(readFeed(xml, 'https://science.test/feed', { clock }).length, 1);
});
test('two independent hosts, deduplication, source citations and anti-hallucinated IDs', () => {
  const articles = [
    { title: 'One research report', summary: 'details', url: 'https://site-one.org/a', host: 'site-one.org', publishedAt: '2026-10-31T00:00:00Z' },
    { title: 'Second research report', summary: 'details', url: 'https://site-two.org/b', host: 'site-two.org', publishedAt: '2026-10-31T00:00:00Z' },
    { title: 'Duplicate', summary: 'details', url: 'https://site-one.org/a', host: 'site-one.org', publishedAt: '2026-10-31T00:00:00Z' }
  ];
  assert.equal(chooseArticles(articles, [], { minHosts: 3 }).length, 0);
  const sources = chooseArticles(articles, []);
  assert.equal(sources.length, 2);
  assert.equal(sourceFingerprint(sources), sourceFingerprint([...sources].reverse()));
  const draft = {
    title: 'Uma investigação da ciência aberta',
    overview: 'Um panorama de pesquisas que aponta possibilidades e limites. '.repeat(4),
    uncertainties: 'Há limitações de metodologia, amostragem e aplicabilidade.',
    sourceIds: ['S1', 'S2'],
    perspectives: [
      { label: 'Benefícios', argument: 'Há oportunidades para colaboração entre equipes e revisão dos métodos.', caveat: 'Os resultados ainda precisam ser replicados.' },
      { label: 'Riscos', argument: 'A metodologia descrita pode não ter cobertura suficiente para generalização.', caveat: 'Precisamos de estudos adicionais.' }
    ],
    questions: ['Como validar os achados?', 'Quais testes adicionais são viáveis?']
  };
  const post = composePost({ label: 'ciência', tag: 'ciencia' }, draft, sources);
  assert.match(post.content, /PERSPECTIVAS PARA DEBATE/);
  assert.match(post.content, /https:\/\/site-two.org\/b/);
  assert.ok(post.content.length <= 3000);
  assert.throws(() => composePost({ label: 'ciência', tag: 'ciencia' }, { ...draft, sourceIds: ['S1', 'S99'] }, sources), /cite/);
});
