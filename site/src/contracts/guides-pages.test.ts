import { describe, expect, it } from 'vitest';

import { LIVE_LIMITS } from '../lib/article-pages';
import { getGp, getGuides, getGuidesIndex, getStateTemplate, label } from '../lib/content';
import { readRules } from '../lib/dist';
import { GP_PATH, GUIDES_PATH, guideFacts, guides } from '../lib/guides';
import { isBuilt } from '../lib/links';
import { surgeryStamp } from '../lib/index-pages';
import { roleLabels } from '../lib/surgery-page';
import { categories } from '../lib/urgency-page';
import gpPage from '../pages/gp.astro';
import guidePage from '../pages/guides/[slug].astro';
import guidesIndexPage from '../pages/guides/index.astro';
import { render, text } from '../lib/test-render';

const all = guides();
const rendered = await Promise.all(
  all.map(async (guide) => ({ guide, html: await render(guidePage, { slug: guide.slug }) })),
);
const indexHtml = await render(guidesIndexPage, {});
const gpHtml = await render(gpPage, {});
const pages = [
  { path: GUIDES_PATH, html: indexHtml },
  { path: GP_PATH, html: gpHtml },
  ...rendered.map(({ guide, html }) => ({ path: guide.path, html })),
];

const rawCopy = (): string[] => {
  const sections = [
    ...getGp().sections,
    ...[...getGuides().values()].flatMap((g) => g.sections),
    ...getGuidesIndex().after,
  ];
  return [
    getGp().lede,
    ...[...getGuides().values()].map((g) => g.lede),
    ...sections.flatMap((s) => [
      s.heading,
      ...s.paragraphs,
      ...(s.items ?? []),
      ...(s.links ?? []).map((l) => l.label),
    ]),
  ];
};

describe('Guides and the page for general practitioners', () => {
  it('build every guide the index orders, and no other', () => {
    expect(all.map((g) => g.slug)).toEqual(getGuidesIndex().order);
    expect(all).toHaveLength(getGuides().size);
  });

  it('give each page one heading, a safety block, no script and no unfilled slot', () => {
    for (const { path, html } of pages) {
      expect(html.match(/<h1[ >]/g), path).toHaveLength(1);
      expect(html, path).toContain('c-safety');
      expect(html, path).toContain('In an emergency, call 000.');
      expect(html, path).not.toContain('<script');
      expect(text(html), path).not.toMatch(/[{}]/);
    }
  });

  it('list every guide on the index with its summary', () => {
    for (const guide of all) {
      expect(indexHtml).toContain(`href="${guide.path}"`);
      expect(text(indexHtml)).toContain(guide.summary);
    }
  });

  it('link only to pages the site builds', () => {
    const links = [
      ...getGuidesIndex().after,
      ...getGp().sections,
      ...[...getGuides().values()].flatMap((g) => g.sections),
    ].flatMap((s) => s.links ?? []);
    expect(links.length).toBeGreaterThan(10);
    for (const { href } of links) {
      const known = isBuilt(href) || all.some((g) => g.path === href);
      expect(known, href).toBe(true);
    }
  });

  it('take every number from the code, the rules or the urgency content', () => {
    const facts = guideFacts();
    expect(facts['neighbours']).toBe(String(readRules().neighbours));
    expect(facts['border_radius']).toBe(String(LIVE_LIMITS.borderRadiusKm));
    expect(facts['border_count']).toBe(String(LIVE_LIMITS.borderCount));
    expect(facts['long_wait_days']).toBe(String(readRules().long_wait_days));
    expect(facts['volume_floor']).toBe(String(LIVE_LIMITS.volumeFloor));
    expect(facts['first_within']).toBe(categories()[0]?.within);
    expect(facts['third_within']).toBe(categories()[2]?.within);
    expect(facts['period']).toBe(surgeryStamp().period);
    const numeric = Object.entries(facts).filter(([, v]) => /^\d+$/.test(v));
    const copy = rawCopy()
      .map((t) => t.replaceAll(/\{[a-z_]+\}/g, ''))
      .join('\n');
    for (const [slot, value] of numeric) {
      expect(copy, slot).not.toMatch(new RegExp(`(?<![\\w.])${value}(?!\\w)`));
    }
  });

  it('take the long-wait threshold from the rules in the labels and templates too', () => {
    const days = String(readRules().long_wait_days);
    const raw = [label('role_long_wait'), getStateTemplate().column_state_long_wait];
    for (const t of raw) {
      expect(t).toContain('{long_wait_days}');
      expect(t).not.toMatch(new RegExp(`(?<![\\w.])${days}(?!\\w)`));
    }
    expect(roleLabels(label).long_wait).toContain(`${days} days`);
  });

  it('state the figures in the pages that use them', () => {
    const facts = guideFacts();
    const referral = rendered.find(({ guide }) => guide.slug === 'referral-to-another-hospital');
    expect(text(referral?.html ?? '')).toContain(
      `${facts['neighbours'] ?? ''} nearest open public hospitals`,
    );
    expect(text(referral?.html ?? '')).toContain(
      `within ${facts['border_radius'] ?? ''} km of each other`,
    );
    expect(text(gpHtml)).toContain(`${facts['second_within'] ?? ''} for category 2`);
    expect(text(gpHtml)).toContain(`waited longer than ${facts['long_wait_days'] ?? ''} days`);
    expect(text(gpHtml)).toContain(`fewer than ${facts['volume_floor'] ?? ''} surgeries`);
  });

  it('recommend no hospital and give no medical advice', () => {
    for (const { path, html } of pages) {
      expect(text(html), path).not.toMatch(
        /\b(?:we|I) recommend\b|\byou should\b|\bbest hospital\b/i,
      );
    }
  });
});
