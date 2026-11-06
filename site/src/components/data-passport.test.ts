import { describe, expect, it } from 'vitest';
import { label } from '../lib/content';
import { CreditError, licenceUrl, readCredits } from '../lib/credits';
import { listDist, readDist } from '../lib/dist';
import { formatDate, formatLicence } from '../lib/format';
import { render, text, textsOf } from '../lib/test-render';
import DataPassport from './DataPassport.astro';

const credits = readCredits();
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('DataPassport', () => {
  it('lists every source a file draws on, with the citation verbatim', async () => {
    for (const slug of listDist('hospitals').slice(0, 3)) {
      const { sources } = readDist(`hospitals/${slug}.json`) as { sources: string[] };
      const html = await render(DataPassport, { sources });
      const citations = textsOf(html, 'c-passport__citation');
      const page = text(html);
      expect(citations).toHaveLength(sources.length);
      for (const source of sources) {
        const credit = credits.find((c) => c.slug === source);
        if (credit === undefined) {
          throw new Error(`${source} has no credit`);
        }
        expect(citations).toContain(credit.citation);
        expect(html).toContain(`href="${credit.dataset_url}"`);
        expect(page).toContain(credit.title);
        expect(page).toContain(credit.publisher.name);
      }
    }
  });

  it('shows the version and release as dates, the licence, and links to publicdata.au', async () => {
    const credit = credits.find((c) => c.as_at !== null);
    expect(credit).toBeDefined();
    const html = await render(DataPassport, { sources: [credit?.slug] });
    const page = text(html);
    expect(page).toContain(formatDate(credit?.version ?? ''));
    expect(page).toContain(formatDate(credit?.as_at ?? ''));
    const link = (href: string, name: string): RegExp =>
      new RegExp(`<a class="c-passport__link" href="${href}"[^>]*>${name}</a>`);
    expect(html).toMatch(link(escape(credit?.dataset_url ?? ''), escape(credit?.title ?? '')));
    expect(html).toMatch(link(escape(licenceUrl('CC-BY-4.0')), formatLicence('CC-BY-4.0')));
    expect(licenceUrl('CC-BY-4.0')).toBe('https://creativecommons.org/licenses/by/4.0/');
  });

  it('says so when the publisher gives no release date', async () => {
    const credit = credits.find((c) => c.as_at === null);
    const html = await render(DataPassport, { sources: [credit?.slug] });
    expect(text(html)).toContain(label('passport_released_none'));
  });

  it('is a labelled section with a heading, a list and no script', async () => {
    const html = await render(DataPassport, { sources: [credits[0]?.slug] });
    expect(html).toContain('aria-labelledby="passport-heading"');
    expect(html).toContain('id="passport-heading"');
    expect(html).toContain('<ul class="c-passport__list"');
    expect(html).toContain('<dl class="c-passport__facts"');
    expect(html).not.toContain('<script');
  });

  it('fails the build when a source has no credit', async () => {
    await expect(render(DataPassport, { sources: ['no-such-dataset'] })).rejects.toThrow(
      CreditError,
    );
    await expect(
      render(DataPassport, { sources: [credits[0]?.slug], credits: [] }),
    ).rejects.toThrow(CreditError);
  });

  it('fails the build for a licence it has no name for', async () => {
    const [first] = credits;
    await expect(
      render(DataPassport, {
        sources: [first?.slug],
        credits: [{ ...first, licence: 'ARR' }],
      }),
    ).rejects.toThrow(RangeError);
  });
});
