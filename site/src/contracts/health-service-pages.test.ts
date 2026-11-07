import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import HealthServiceIndex from '../components/HealthServiceIndex.astro';
import HealthServicePage from '../components/HealthServicePage.astro';
import HospitalPage from '../pages/hospital/[slug]/index.astro';
import { getHealthServiceTemplate, getSite } from '../lib/content';
import {
  DIST_ENV,
  distDirectory,
  listDist,
  readHealthService,
  readHealthServiceIndex,
  readHospital,
} from '../lib/dist';
import { formatDate, formatFigure, formatPeriod } from '../lib/format';
import {
  HEALTH_SERVICES_PATH,
  healthServicePath,
  healthServiceRoutes,
  healthServiceSlugs,
  memberTable,
} from '../lib/health-service-page';
import { hospitalPath } from '../lib/hospital-page';
import type { HealthService } from '../lib/dist';
import { fill } from '../lib/slots';
import { render, text, textsOf } from '../lib/test-render';

const t = getHealthServiceTemplate();
const site = getSite();
const slugs = healthServiceSlugs();
const pages = await Promise.all(
  slugs.map(async (slug) => ({ slug, html: await render(HealthServicePage, { slug }) })),
);
const indexHtml = await render(HealthServiceIndex, {});
const main = (html: string): string => text(html.split('<main')[1] ?? html);
const everyPage = [{ slug: '', html: indexHtml }, ...pages];

function hrefs(html: string): string[] {
  return [...(html.split('<main')[1] ?? html).matchAll(/<a [^>]*href="([^"]+)"/g)].map(
    (m) => m[1] ?? '',
  );
}

describe('Health service addresses', () => {
  it('give one page for each network file and an index at the earlier address', () => {
    expect(HEALTH_SERVICES_PATH).toBe('/health-service/');
    expect(slugs).toEqual(listDist('health-services'));
    expect(healthServiceRoutes().map((r) => r.params.slug)).toEqual(slugs);
    expect(slugs.map(healthServicePath)).toEqual(slugs.map((s) => `/health-service/${s}/`));
  });

  it('list every network once on the index, under its state', () => {
    const linked = hrefs(indexHtml).filter(
      (h) => h.startsWith('/health-service/') && h !== '/health-service/',
    );
    for (const row of readHealthServiceIndex()) {
      expect(linked.filter((h) => h === healthServicePath(row.slug)).length).toBe(
        row.states.length,
      );
    }
  });
});

describe('Every health service page', () => {
  it('states the exclusion, the safety block once and the passport once', () => {
    for (const { slug, html } of everyPage) {
      expect(main(html), slug).toContain(t.exclusion);
      expect(html.match(/id="[a-z-]+-safety-heading"/g) ?? [], slug).toHaveLength(1);
      expect((html.match(/class="c-passport"/g) ?? []).length, slug).toBe(1);
    }
  });

  it('ships no script, carries one h1 and a canonical address', () => {
    for (const { slug, html } of everyPage) {
      expect([slug, /<script|\son[a-z]+=|javascript:/i.test(html)]).toEqual([slug, false]);
      expect(html.match(/<h1[ >]/g), slug).toHaveLength(1);
      const path = slug === '' ? HEALTH_SERVICES_PATH : healthServicePath(slug);
      expect(html, slug).toContain(`<link rel="canonical" href="${site.url}${path.slice(1)}">`);
    }
  });

  it('gives every table a stated period and release, and ranks nothing', () => {
    for (const { slug, html } of pages) {
      expect(textsOf(html, 'c-plain-table__stamp'), slug).toHaveLength(1);
      expect(html, slug).not.toMatch(/c-table__rank|nationally/);
    }
  });

  it('links each member to its hospital page and lists every member once', () => {
    for (const { slug, html } of pages) {
      const service = readHealthService(slug);
      const links = hrefs(html);
      for (const member of service.hospitals) {
        expect(readHospital(member.slug).network?.slug, member.slug).toBe(slug);
        expect(
          links.filter((h) => h === hospitalPath(member.slug)),
          member.slug,
        ).toHaveLength(1);
      }
    }
  });

  it('shows each member with its own figure, and shows a stale one with its own period and no value', () => {
    let stale = 0;
    for (const { slug, html } of pages) {
      const service = readHealthService(slug);
      const body = main(html);
      for (const member of service.hospitals) {
        const u = member.urgent_on_time;
        const row = memberTable(service).rows.find((r) => r.href === hospitalPath(member.slug));
        const cell = row?.cells[2]?.text ?? '';
        expect(body, member.slug).toContain(cell);
        if (u.status === 'stale' && u.period !== null && u.release !== null) {
          stale += 1;
          expect(cell, member.slug).toBe(
            fill(t.stale_cell, {
              stamp: `${formatPeriod(u.period)}, released ${formatDate(u.release)}`,
            }),
          );
          expect(cell, member.slug).not.toMatch(/\d%/);
        }
        if (u.figure !== null && u.status !== 'stale') {
          expect(cell.startsWith(formatFigure('on_time', u.figure)), member.slug).toBe(true);
        }
      }
    }
    expect(stale).toBeGreaterThan(0);
  });

  it('links only to pages that are built', () => {
    const built = new Set<string>([
      '/',
      '/hospitals/',
      '/urgency/',
      '/urgency/category-1/',
      HEALTH_SERVICES_PATH,
    ]);
    for (const slug of slugs) {
      built.add(healthServicePath(slug));
      for (const m of readHealthService(slug).hospitals) {
        built.add(hospitalPath(m.slug));
      }
    }
    for (const { slug, html } of everyPage) {
      for (const href of hrefs(html).filter((h) => h.startsWith('/') && !h.startsWith('/state/'))) {
        expect([slug, href, built.has(href)]).toEqual([slug, href, true]);
      }
    }
  });
});

describe('The hospital page', () => {
  it('links the network page from the about card when the network has a page', async () => {
    const service = readHealthService(slugs[0] ?? '');
    const member = service.hospitals[0];
    const html = await render(HospitalPage, { slug: member?.slug });
    expect(hrefs(html)).toContain(healthServicePath(service.slug));
  });
});

const copies: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const copy of copies.splice(0)) {
    rmSync(copy, { recursive: true, force: true });
  }
});

// A copy of the dist that a test may edit, which the site then reads instead.
function editedService(change: (service: HealthService) => void): string {
  const copy = mkdtempSync(join(tmpdir(), 'dist-'));
  copies.push(copy);
  cpSync(distDirectory(), copy, { recursive: true });
  vi.stubEnv(DIST_ENV, copy);
  const file = join(copy, `health-services/${slugs[0] ?? ''}.json`);
  const service = JSON.parse(readFileSync(file, 'utf8')) as HealthService;
  change(service);
  writeFileSync(file, JSON.stringify(service));
  return slugs[0] ?? '';
}

describe('A member with no urgent figure', () => {
  it('says the source has none, with no value and no period', () => {
    const slug = editedService((service) => {
      const member = service.hospitals[0];
      if (member !== undefined) {
        member.urgent_on_time = { status: 'missing', figure: null, period: null, release: null };
      }
    });
    const rows = memberTable(readHealthService(slug)).rows;
    expect(rows.some((row) => row.cells[2]?.text === t.missing_cell)).toBe(true);
  });

  it('stops the build when a count is not for the newest period', () => {
    const slug = editedService((service) => {
      const first = service.hospitals.find((m) => m.surgeries.current.length > 0);
      const entry = first?.surgeries.current[0];
      if (entry !== undefined) {
        entry.period = '2019–20';
      }
    });
    expect(() => memberTable(readHealthService(slug))).toThrow(/newest period/);
  });
});
