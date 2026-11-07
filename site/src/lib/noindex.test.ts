import { describe, expect, it } from 'vitest';

import { hasNoindex } from './noindex';

const head = (meta: string): string =>
  `<!doctype html><html><head>${meta}</head><body></body></html>`;

describe('hasNoindex', () => {
  it.each([
    '<meta name="robots" content="noindex,follow">',
    '<meta content="noindex" name="robots">',
    "<meta name='robots' content='follow, noindex'>",
    '<meta name=robots content=noindex>',
    '<META NAME="Robots" CONTENT="NoIndex">',
    '<meta name="robots" content="none">',
    '<meta name="robots" content="nofollow noindex">',
  ])('finds %s', (meta) => {
    expect(hasNoindex(head(meta))).toBe(true);
  });

  it.each([
    '<meta name="robots" content="index,follow">',
    '<meta name="description" content="noindex">',
    '<meta name="robots" content="nonexistent">',
    '<meta name="robots">',
    '',
  ])('passes %s', (meta) => {
    expect(hasNoindex(head(meta))).toBe(false);
  });

  it('ignores the word in the page text', () => {
    expect(hasNoindex(head('').replace('<body>', '<body><p>noindex</p>'))).toBe(false);
  });
});
