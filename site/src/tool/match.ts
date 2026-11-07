import { NAMES } from './dom';

const MARKS = /\p{M}/gu;
const NOT_WORD = /[^a-z0-9]+/g;

export const normalise = (text: string): string =>
  text.normalize(NAMES.normalForm).replace(MARKS, '').toLowerCase().replace(NOT_WORD, ' ').trim();

export interface Candidate {
  // Fields in order of preference: a name before a word found under it.
  fields: string[];
}

// 0 when a field starts with the query, 1 when each word starts a word of the field, 2 when each is inside it.
function fieldScore(field: string, words: string[], whole: string): number {
  if (field.startsWith(whole)) {
    return 0;
  }
  const parts = field.split(' ');
  if (words.every((w) => parts.some((part) => part.startsWith(w)))) {
    return 1;
  }
  return words.every((w) => field.includes(w)) ? 2 : Infinity;
}

// The best-scoring candidates for a query, best first; ties keep the order given.
export function rank<T extends Candidate>(
  items: readonly T[],
  query: string,
  limit: number,
): { item: T; field: number }[] {
  const whole = normalise(query);
  if (whole === '') {
    return [];
  }
  const words = whole.split(' ');
  const scored: { item: T; field: number; score: number; at: number }[] = [];
  items.forEach((item, at) => {
    let best = { score: Infinity, field: 0 };
    item.fields.forEach((field, index) => {
      const score = fieldScore(field, words, whole) * 2 + (index === 0 ? 0 : 1);
      if (score < best.score) {
        best = { score, field: index };
      }
    });
    if (best.score < Infinity) {
      scored.push({ item, field: best.field, score: best.score, at });
    }
  });
  return scored
    .sort((a, b) => a.score - b.score || a.at - b.at)
    .slice(0, limit)
    .map(({ item, field }) => ({ item, field }));
}
