// Check factual quantities stated as digits or common cardinal words.
// The function deliberately does NOT attempt arithmetic, unit conversion,
// ordinals, ranges or implied quantities. It is an evidence-presence guard.
import { normalized } from './research-core.mjs';

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
const fold = value => normalized(value).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
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
