import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedText } from '../cloudflare/request-body.mjs';

const request = (stream, headers = {}) =>
  new Request('https://forum.example/api/topics', {
    method: 'POST', headers, body: stream, duplex: 'half'
  });
const bytes = s => new TextEncoder().encode(s);
const withChunks = (...chunks) => new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(bytes(chunk)); controller.close(); }
});

test('streamed body preserves UTF-8 under an exact byte limit without Content-Length', async () => {
  const incoming = request(withChunks('Olá', ' mundo!'));
  assert.equal(await readBoundedText(incoming, bytes('Olá mundo!').length), 'Olá mundo!');
});

test('streamed body refuses over-limit chunks and cancels the upstream reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes('12345678')); controller.enqueue(bytes('9012345')); },
    cancel() { cancelled = true; }
  });
  await assert.rejects(readBoundedText(request(stream), 10), e => e.status === 413);
  assert.equal(cancelled, true);
});

test('predeclared oversize body is rejected before reading any stream', async () => {
  let pulls = 0;
  const stream = new ReadableStream({ pull() { pulls++; } }, { highWaterMark: 0 });
  await assert.rejects(readBoundedText(request(stream, { 'Content-Length': '40000' }), 12000), e => e.status === 413);
  assert.equal(pulls, 0);
});

test('byte cap counts UTF-8 bytes rather than character count', async () => {
  await assert.rejects(readBoundedText(request(withChunks('é'.repeat(7))), 12), e => e.status === 413);
});

test('invalid UTF-8 is rejected instead of silently rewriting source text', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.of(0xC3, 0x28)); controller.close(); } });
  await assert.rejects(readBoundedText(request(body)), e => e.status === 400);
});

test('empty body returns empty string for each route parser to reject appropriately', async () => {
  const incoming = new Request('https://forum.example/api/topics', { method: 'POST' });
  assert.equal(await readBoundedText(incoming), '');
});
