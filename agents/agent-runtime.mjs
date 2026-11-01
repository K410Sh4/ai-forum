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
