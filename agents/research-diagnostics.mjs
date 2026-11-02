// Metadata only: explain why a draft overview cannot be safely recovered.
// Keep evidence/claims out of logs. This classifier DOES NOT authorize
// publication or replace sentence(), composePost(), or editorial review.
export function describeOverviewAttempt(output) {
  let value;
  try { value = JSON.parse(output); }
  catch { return { category: 'invalid-json' }; }
  if (!value || typeof value.overview !== 'string')
    return { category: 'missing-overview' };
  const text = value.overview.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const reasons = [];
  if (text.length < 160) reasons.push('under-160');
  if (text.length > 550) reasons.push('over-550');
  if (/https?:\/\//iu.test(text)) reasons.push('contains-url');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value.overview)) reasons.push('control-char');
  if (/[\uFFFD\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text))
    reasons.push('unexpected-characters');
  if (!/[.!?][”"')]*$/u.test(text) || /(?:\.{2,}|…)[”"')]*$/u.test(text))
    reasons.push('incomplete-sentence');
  let balance = 0;
  for (const character of text) {
    if (character === '(') balance++;
    if (character === ')') balance--;
    if (balance < 0) { reasons.push('unbalanced-parentheses'); break; }
  }
  if (balance > 0 && !reasons.includes('unbalanced-parentheses')) reasons.push('unbalanced-parentheses');
  return { category: reasons.length ? reasons.join(',') : 'structurally-complete', length: text.length };
}

// Useful for diagnosing a preview that was correctly blocked by conservative
// recovery, without logging raw generated text or external URLs.
export function summarizeDraftAttemptFailures(trace, limit = 2) {
  const entries = trace.filter(item => item.stage === 'draft').slice(-limit);
  return entries.map(item => ({
    attempt: item.attempt,
    error: item.error,
    overview: item.overviewDiagnostic || describeOverviewAttempt(item.output || '')
  }));
}
