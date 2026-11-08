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
  readHospitalIndex,
} from '../lib/dist';
import { formatCount, formatDate, formatFigure, formatPeriod } from '../lib/format';
import {
  HEALTH_SERVICES_PATH,
  healthServicePath,
  healthServiceRoutes,
  healthServiceSlugs,
  indexGroups,
  memberTable,
} from '../lib/health-service-page';
import { hospitalPath } from '../lib/hospital-page';
import type { HealthService } from '../lib/dist';
import { fill } from '../lib/slots';
import { getHospitalTemplate } from '../lib/content';
import { render, text, textsOf, withoutSiteScripts } from '../lib/test-render';

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

  it('ships no script of its own, carries one h1 and a canonical address', () => {
    for (const { slug, html } of everyPage) {
      expect([slug, /<script|\son[a-z]+=|javascript:/i.test(withoutSiteScripts(html))]).toEqual([
        slug,
        false,
      ]);
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
      '/compare/',
      '/agents/',
      '/hospitals/',
      '/urgency/',
      '/urgency/category-1/',
      HEALTH_SERVICES_PATH,
      '/methodology/',
      '/data/',
      '/guides/',
      '/gp/',
      '/about/',
      '/privacy/',
      '/terms/',
      '/accessibility/',
      '/corrections/',
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
function editedService(change: (service: HealthService) => void, minMembers = 1): string {
  const chosen = slugs.find((slug) => readHealthService(slug).hospitals.length >= minMembers) ?? '';
  const copy = mkdtempSync(join(tmpdir(), 'dist-'));
  copies.push(copy);
  cpSync(distDirectory(), copy, { recursive: true });
  vi.stubEnv(DIST_ENV, copy);
  const file = join(copy, `health-services/${chosen}.json`);
  const service = JSON.parse(readFileSync(file, 'utf8')) as HealthService;
  change(service);
  writeFileSync(file, JSON.stringify(service));
  return chosen;
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
      const entry = service.hospitals[0]?.surgeries.procedures;
      if (entry !== undefined) {
        entry.period = '2019–20';
      }
    });
    expect(() => memberTable(readHealthService(slug))).toThrow(/newest period/);
  });
});

describe('The surgery type count', () => {
  it('says in the caption that the count includes types with no published figure', () => {
    for (const { slug, html } of pages) {
      const caption = html.split('<caption')[1]?.split('</caption>')[0] ?? '';
      expect(text(caption), slug).toContain(t.types_note);
      expect(t.types_note).toMatch(/published no figures/);
      expect(t.types_note).toMatch(/not a count of published figures/);
    }
  });

  it('says the order is by state first only for a network that spans states', async () => {
    for (const { slug, html } of pages) {
      const intro =
        readHealthService(slug).states.length > 1 ? t.hospitals_intro_states : t.hospitals_intro;
      expect(main(html), slug).toContain(intro);
    }
    const slug = editedService((service) => {
      service.states = ['NSW', 'Qld'];
      const member = service.hospitals[0];
      if (member !== undefined) {
        member.state = 'Qld';
      }
    });
    const html = await render(HealthServicePage, { slug });
    expect(main(html)).toContain(t.hospitals_intro_states);
    expect(main(html)).not.toContain(t.hospitals_intro);
  });

  it('lists members by name, with state first only for a network that spans states', () => {
    const collator = new Intl.Collator('en-AU');
    for (const slug of slugs) {
      const service = readHealthService(slug);
      const names = memberTable(service).rows.map((row) => row.name.replace(/ \(closed\)$/, ''));
      const expected = [...service.hospitals]
        .sort(
          (a, b) =>
            (service.states.length > 1 ? collator.compare(a.state, b.state) : 0) ||
            collator.compare(a.name, b.name),
        )
        .map((m) => m.name);
      expect(names, slug).toEqual(expected);
    }
    expect(Object.values(t).join(' ')).not.toMatch(/more categories come first/);
  });

  it('shows the procedure count, and a plain sentence in place of a 0', () => {
    const slug = editedService((service) => {
      const [first, second] = service.hospitals;
      if (first !== undefined) {
        first.surgeries.procedures.count = 0;
      }
      if (second !== undefined) {
        second.surgeries.procedures.count = 7;
      }
    }, 2);
    const service = readHealthService(slug);
    const rows = memberTable(service).rows;
    const byHref = (m: { slug: string }): (typeof rows)[number] | undefined =>
      rows.find((r) => r.href === hospitalPath(m.slug));
    const [first, second] = service.hospitals;
    expect(byHref(first ?? { slug: '' })?.cells[1]).toEqual({
      text: t.no_types_cell,
      withheld: true,
    });
    expect(byHref(second ?? { slug: '' })?.cells[1]).toEqual({ text: '7', withheld: false });
    expect(JSON.stringify(rows)).not.toMatch(/"text":"0"/);
  });

  it('does not use the unexpanded abbreviation in a cell', () => {
    for (const slug of slugs) {
      for (const row of memberTable(readHealthService(slug)).rows) {
        expect(row.cells.map((c) => c.text).join(' '), slug).not.toMatch(/AIHW/);
      }
    }
  });
});

describe('The index of networks that span states', () => {
  it("lists the network under each state with that state's own count", () => {
    const states = Object.keys(getHospitalTemplate().states);
    const slug = editedService((service) => {
      const [first, second] = service.hospitals;
      const other = states.find((s) => !service.states.includes(s as never));
      if (first === undefined || second === undefined || other === undefined) {
        throw new RangeError('the fixture network needs two hospitals');
      }
      second.state = other as never;
      service.states = [first.state, other as never].sort();
      const copy = distDirectory();
      const file = join(copy, 'health-services.json');
      const index = JSON.parse(readFileSync(file, 'utf8')) as {
        networks: { slug: string; states: string[] }[];
      };
      const row = index.networks.find((r) => r.slug === service.slug);
      if (row !== undefined) {
        row.states = service.states;
      }
      writeFileSync(file, JSON.stringify(index));
    }, 2);
    const service = readHealthService(slug);
    const home = service.hospitals[0]?.state ?? '';
    const away = service.hospitals[1]?.state ?? '';
    const found = indexGroups(states).flatMap((g) =>
      g.networks
        .filter((n) => n.href === healthServicePath(slug))
        .map((n) => ({ ...n, state: g.state })),
    );
    const homeCount = service.hospitals.filter((m) => m.state === home).length;
    expect(found.map((f) => [f.state, f.hospitals, f.spansStates]).sort()).toEqual(
      [
        [home, homeCount, true],
        [away, service.hospitals.length - homeCount, true],
      ].sort(),
    );
  });
});

// Each member's counts and urgent figure, worked out again from its own hospital file.
describe.skipIf(process.env[DIST_ENV] === undefined)(
  'Health service pages against the hospital files',
  () => {
    it('show each member with the counts and urgent figure its hospital file gives', () => {
      let zero = 0;
      let stale = 0;
      const procedures = new Map(
        readHospitalIndex().map((row) => [row.slug, readHospital(row.slug).surgeries]),
      );
      for (const { slug, html } of pages) {
        const service = readHealthService(slug);
        const body = main(html);
        const rows = memberTable(service).rows;
        for (const member of service.hospitals) {
          const surgeries = procedures.get(member.slug) ?? [];
          const countOf = (kind: string): number =>
            surgeries.filter((s) => s.kind === kind && !s.stale).length;
          expect(member.surgeries.urgency.count, member.slug).toBe(countOf('urgency'));
          expect(member.surgeries.procedures.count, member.slug).toBe(countOf('procedure'));
          expect(member.surgeries.specialties.count, member.slug).toBe(countOf('specialty'));
          const row = rows.find((r) => r.href === hospitalPath(member.slug));
          const expected = countOf('procedure');
          if (expected === 0) {
            zero += 1;
            expect(row?.cells[1]?.text, member.slug).toBe(t.no_types_cell);
            expect(row?.cells[1]?.withheld, member.slug).toBe(true);
          } else {
            expect(row?.cells[1]?.text, member.slug).toBe(formatCount(expected));
          }
          expect(body, member.slug).toContain(row?.cells[1]?.text ?? '');
          const urgent = surgeries.find(
            (s) => s.kind === 'urgency' && s.slug === 'urgent-elective-surgery',
          );
          const u = member.urgent_on_time;
          if (urgent === undefined) {
            expect(u.status, member.slug).toBe('missing');
          } else if (urgent.stale) {
            stale += 1;
            expect(u.status, member.slug).toBe('stale');
            expect(u.figure, member.slug).toBeNull();
          } else {
            expect(u.figure, member.slug).toEqual(urgent.measures.on_time?.figure);
          }
        }
      }
      expect(zero).toBeGreaterThan(0);
      expect(stale).toBeGreaterThan(0);
    });
  },
);
