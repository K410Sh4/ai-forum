// Check factual quantities stated as digits or common cardinal words.
// The function deliberately does NOT attempt arithmetic, unit conversion,
// ordinals, ranges or implied quantities. It is an evidence-presence guard.
const names = new Map(Object.entries({
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4,
  cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14,
  quinze: 15, dezesseis: 16, dezassete: 17, dezessete: 17,
  dezoito: 18, dezenove: 19, vinte: 20,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20
}));
const fold = value => String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
const tokens = /\b\d+(?:[.,]\d+)?\b|\b[a-z]+\b/gu;

export function factualNumbers(text) {
  const found = [];
  for (const match of fold(text).matchAll(tokens)) {
    const token = match[0];
    if (/^\d/u.test(token)) {
      found.push(token.replace(',', '.'));
      continue;
    }
    if (!names.has(token)) continue;
    // PT articles are not reliable claims of quantity, e.g. "um estudo".
    // Numerals >= 2 are counted; English "one" remains numeric.
    if (token === 'um' || token === 'uma') continue;
    found.push(String(names.get(token)));
  }
  return found;
}

export function assertNumbersFromEvidence(statement, quote, prefix = 'Numeric fact is absent from its evidence quote') {
  const evidence = new Set(factualNumbers(quote));
  if (factualNumbers(statement).some(value => !evidence.has(value))) throw Error(prefix);
}


// Detect a narrow, high-impact class of quantity swaps: a cited number may
// exist in the quote but refer to a DIFFERENT group. This is deliberately not
// a general-purpose semantic evaluator. Unknown relations require human review.
const GROUPS = {
  faculty: token => /^(?:faculty|docent(?:e|es)|professor(?:a|as|es)?)$/u.test(token),
  alumni: (token, next) => token === 'alumni' || (token === 'ex' && /^alun(?:o|a|os|as)$/u.test(next || ''))
};
const GROUP_BARRIERS = new Set([
  'years', 'year', 'anos', 'ano', 'projects', 'project', 'projetos',
  'projeto', 'papers', 'paper', 'studies', 'study', 'estudos', 'estudo',
  'scholarships', 'scholarship', 'bolsas', 'bolsa', 'datasets', 'dataset'
]);
function numericValue(token) {
  if (/^\d+(?:[.,]\d+)?$/u.test(token)) return token.replace(',', '.');
  if (token === 'um' || token === 'uma') return null;
  return names.has(token) ? String(names.get(token)) : null;
}
export function quantifiedGroups(text) {
  const words = fold(text).match(/[a-z]+|\d+(?:[.,]\d+)?/gu) || [];
  const linked = [];
  for (let index = 0; index < words.length; index++) {
    const value = numericValue(words[index]);
    if (value === null) continue;
    for (let look = index + 1; look <= index + 6 && look < words.length; look++) {
      if (numericValue(words[look]) !== null || GROUP_BARRIERS.has(words[look])) break;
      const group = Object.entries(GROUPS).find(([, test]) => test(words[look], words[look + 1]))?.[0];
      if (group) { linked.push({ group, value }); break; }
    }
  }
  return linked;
}
export function assertNumbersByGroupFromEvidence(statement, quote) {
  const claimed = quantifiedGroups(statement);
  if (!claimed.length) return;
  const supported = new Set(quantifiedGroups(quote).map(item => item.group + ':' + item.value));
  for (const item of claimed) {
    if (!supported.has(item.group + ':' + item.value))
      throw Error('Numeric claim is assigned to an unsupported source group: ' + item.group);
  }
}
