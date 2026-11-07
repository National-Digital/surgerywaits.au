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

export interface Place extends Candidate {
  state: string;
  // The normalised name, for the order within a tier.
  name: string;
}

// 0 for the name itself, 1 for a name that starts with the query as whole words, 2 for any other match.
const tierOf = (field: string, words: string[], whole: string): number =>
  field === whole
    ? 0
    : field.startsWith(`${whole} `)
      ? 1
      : fieldScore(field, words, whole) < 3
        ? 2
        : Infinity;

// Matching places, best tier first and by state then name inside a tier.
export function rankPlaces<T extends Place>(
  items: readonly T[],
  query: string,
  limit: number,
): T[] {
  const whole = normalise(query);
  if (whole === '') {
    return [];
  }
  const words = whole.split(' ');
  return items
    .map((item, at) => ({
      item,
      at,
      tier: Math.min(...item.fields.map((field) => tierOf(field, words, whole))),
    }))
    .filter(({ tier }) => tier < Infinity)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        (a.item.state < b.item.state ? -1 : a.item.state > b.item.state ? 1 : 0) ||
        (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0) ||
        a.at - b.at,
    )
    .slice(0, limit)
    .map(({ item }) => item);
}
