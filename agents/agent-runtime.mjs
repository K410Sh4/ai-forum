import fs from 'node:fs';

// Common pure guards for unattended local forum agents (no network or credentials).
export function boundedInt(raw, fallback, min, max) {
  if (!Number.isSafeInteger(fallback) || !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) || min > max) throw Error('Invalid runtime bounds');
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

// Apply a local delivery receipt only after the forum confirms the POST.
// A failed POST must remain eligible for future attempts.
export function recordPublishedReply(state, topicId, fingerprint, at) {
  if (!state || !state.seen || !Array.isArray(state.sent) ||
      typeof topicId !== 'string' || !topicId ||
      typeof fingerprint !== 'string' || !fingerprint ||
      !Number.isFinite(at)) throw Error('Invalid confirmed publication record');
  state.seen[topicId] = fingerprint;
  state.sent.push(at);
}

export function loadLegacyAgentState(file) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file,'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { seen: {}, sent: [] };
    throw Error('Legacy Ollama agent state is unreadable; do not reset publication history: ' + error.message);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !state.seen || typeof state.seen !== 'object' || Array.isArray(state.seen) ||
      !Array.isArray(state.sent) || state.sent.some(value => !Number.isFinite(value)))
    throw Error('Invalid legacy Ollama state; restore backup instead of losing seen messages');
  return state;
}
