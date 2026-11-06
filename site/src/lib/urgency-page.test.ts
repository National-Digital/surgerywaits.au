import { describe, expect, it, vi } from 'vitest';

import { getUrgencyTemplate } from './content';
import type * as Content from './content';
import { categories } from './urgency-page';

const swap = vi.hoisted(() => ({ reversed: false }));

vi.mock('./content', async (importOriginal) => {
  const original = await importOriginal<typeof Content>();
  return {
    ...original,
    getUrgencyTemplate: (): ReturnType<typeof Content.getUrgencyTemplate> => {
      const t = original.getUrgencyTemplate();
      return swap.reversed ? { ...t, categories: [...t.categories].reverse() } : t;
    },
  };
});

describe('categories', () => {
  it('pairs each category with the data file of the same name', () => {
    swap.reversed = false;
    expect(categories().map((c) => c.slug)).toEqual(
      getUrgencyTemplate().categories.map((c) => `${c.short}-elective-surgery`),
    );
  });

  it('throws when the content lists the categories in a different order from the data', () => {
    swap.reversed = true;
    try {
      expect(() => categories()).toThrow(RangeError);
    } finally {
      swap.reversed = false;
    }
  });
});
