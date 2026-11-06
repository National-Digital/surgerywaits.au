import { describe, expect, it } from 'vitest';

import { mark } from '../lib/brand-mark';
import { render } from '../lib/test-render';
import Masthead from './Masthead.astro';

describe('Masthead', () => {
  it('renders the same markup every time and leaves the shared mark as it was', async () => {
    const before = JSON.stringify(mark);
    const pages = [
      await render(Masthead, {}),
      await render(Masthead, {}),
      await render(Masthead, {}),
    ];
    expect(pages[1]).toBe(pages[0]);
    expect(pages[2]).toBe(pages[0]);
    expect(JSON.stringify(mark)).toBe(before);
  });
});
