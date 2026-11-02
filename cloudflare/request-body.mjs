// Bounded, streaming UTF-8 request reader used by all public Worker POST routes.
// Never call Request.text() before enforcing a byte limit: chunked requests may
// omit Content-Length, and buffering the entire body invites resource abuse.
const httpError = (status, message) => ({ status, body: { error: message } });

export async function readBoundedText(request, maxBytes = 12000) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1048576)
    throw Error('Invalid request body byte limit');
  const length = request.headers.get('content-length');
  if (length !== null) {
    const declared = Number(length);
    if (Number.isFinite(declared) && declared > maxBytes)
      throw httpError(413, 'Corpo da requisição excede o limite permitido');
  }
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array))
        throw httpError(400, 'Corpo da requisição inválido');
      if (value.byteLength > maxBytes - total) {
        try { await reader.cancel('Request body byte limit exceeded'); } catch { /* already aborted */ }
        throw httpError(413, 'Corpo da requisição excede o limite permitido');
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw httpError(400, 'Corpo UTF-8 inválido'); }
}
