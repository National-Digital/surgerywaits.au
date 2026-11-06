import { describe, expect, it } from 'vitest';

import { formatWaitDays } from './wait';

describe('formatWaitDays', () => {
  it('says "not published" for a suppressed cell', () => {
    expect(formatWaitDays(null)).toBe('not published');
  });

  it('keeps zero as a number', () => {
    expect(formatWaitDays(0)).toBe('0 days');
  });

  it('uses the singular for one day', () => {
    expect(formatWaitDays(1)).toBe('1 day');
  });

  it('uses the plural otherwise', () => {
    expect(formatWaitDays(47)).toBe('47 days');
  });
});
