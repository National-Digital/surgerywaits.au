import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import { describe, expect, it } from 'vitest';

import {
  ABOUT_PATH,
  ACCESSIBILITY_PATH,
  CORRECTIONS_PATH,
  DATA_PATH,
  METHODOLOGY_PATH,
  PRIVACY_PATH,
  TERMS_PATH,
} from '../lib/article-pages';
import { GP_PATH, GUIDES_PATH } from '../lib/guides';
import HomePage from '../components/HomePage.astro';
import { getHomeTemplate, getSite } from '../lib/content';
import { readHospital, readHospitalIndex, readSurgeryIndex } from '../lib/dist';
import { formatCount, formatDayParts, formatDays, formatKilometres } from '../lib/format';
import { stateName } from '../lib/state-page';
import {
  COMMON_COUNT,
  commonProcedures,
  homeCounts,
  homeStamps,
  midSentence,
} from '../lib/home-page';
import { hospitalStamp, surgeryStamp } from '../lib/index-pages';
import {
  BORDER_PATH,
  CHANGES_PATH,
  LONGEST_PATH,
  borderPairs,
  longestEntries,
  movePeriods,
  stateMoves,
} from '../lib/longest-page';
import { stateFiles, statePath, statesStamp } from '../lib/state-page';
import { surgeryPath, surgeryRefs } from '../lib/surgery-page';
import { categories, urgencyStamp } from '../lib/urgency-page';
import { fill } from '../lib/slots';
import { elementsOf, render, text, textsOf, withoutSiteScripts } from '../lib/test-render';

const t = getHomeTemplate();
const site = getSite();
const html = await render(HomePage, {});
const main = text(html.split('<main')[1] ?? html);

function hrefs(source: string): string[] {
  const out: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node && node.tagName === 'a') {
      out.push(node.attrs.find((a) => a.name === 'href')?.value ?? '');
    }
    if ('childNodes' in node) {
      node.childNodes.forEach(visit);
    }
  };
  visit(parseFragment(source));
  return out;
}

// Pages that are built, so a link to a page still to come fails here.
const BUILT = new Set([
  '/surgery/',
  '/specialty/',
  '/hospitals/',
  '/state/',
  '/urgency/',
  '/compare/',
  '/agents/',
  LONGEST_PATH,
  CHANGES_PATH,
]);

describe('Home page', () => {
  it('has one h1, a title and canonical address from content, and no breadcrumbs', () => {
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(html).toContain(`<link rel="canonical" href="${site.url}">`);
    expect(html).toContain(`<title>${fill(t.title, { site: site.name })}</title>`);
    expect(textsOf(html, 'c-breadcrumbs__item')).toEqual([]);
    expect(main).toContain(t.heading);
  });

  it('links to the index of each way to look, and to each state, category and common surgery', () => {
    const links = hrefs(html);
    for (const index of BUILT) {
      expect(links).toContain(index);
    }
    for (const file of stateFiles()) {
      expect(links).toContain(statePath(file.state));
    }
    for (const category of categories()) {
      expect(links).toContain(category.path);
    }
    const common = links.filter((h) => h.startsWith('/surgery/') && h !== '/surgery/');
    expect(common).toHaveLength(COMMON_COUNT);
  });

  it('links only to pages that are built', () => {
    const built = new Set<string>([
      ...BUILT,
      BORDER_PATH,
      METHODOLOGY_PATH,
      DATA_PATH,
      ABOUT_PATH,
      GUIDES_PATH,
      GP_PATH,
      PRIVACY_PATH,
      TERMS_PATH,
      ACCESSIBILITY_PATH,
      CORRECTIONS_PATH,
    ]);
    for (const file of stateFiles()) {
      built.add(statePath(file.state));
    }
    for (const category of categories()) {
      built.add(category.path);
    }
    for (const ref of surgeryRefs()) {
      built.add(surgeryPath(ref));
    }
    for (const href of hrefs(html).filter((h) => h.startsWith('/'))) {
      expect([href, built.has(href) || href === '/' || href.startsWith('/#')]).toEqual([
        href,
        true,
      ]);
    }
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
    for (const href of hrefs(html).filter((h) => h.startsWith('#'))) {
      expect([href, href === '#top' || ids.has(href.slice(1))]).toEqual([href, true]);
    }
  });

  it('counts what the dist holds, each count under the stamp of its own dataset', () => {
    expect(main).toContain(fill(t.surgery_note_many, { count: formatCount(surgeryRefs().length) }));
    expect(main).toContain(
      fill(t.hospitals_note_many, { count: formatCount(readHospitalIndex().length) }),
    );
    expect(main).toContain(fill(t.states_note_many, { count: formatCount(stateFiles().length) }));
    expect(main).toContain(fill(t.urgency_note_many, { count: formatCount(categories().length) }));
    expect(t.hospitals_note_many).toContain('on the register');
  });

  it('says surgeries where the data counts surgeries, and does not call them patients treated', () => {
    expect(t.common_surgeries).toContain('Surgeries');
    expect(/patients treated|most patients/i.test(main)).toBe(false);
  });

  it('fails loudly when the data holds fewer surgery types than the table needs', () => {
    const available = readSurgeryIndex().filter((row) => row.kind === 'procedure').length;
    expect(() => commonProcedures(available + 1)).toThrow(RangeError);
  });

  it('orders the common surgeries by hospitals reporting, most first, under one stamp', () => {
    const expected = readSurgeryIndex()
      .filter((row) => row.kind === 'procedure')
      .sort(
        (a, b) =>
          b.hospitals - a.hospitals ||
          a.name.localeCompare(b.name, 'en-AU') ||
          (a.slug < b.slug ? -1 : 1),
      )
      .slice(0, COMMON_COUNT);
    const refs = new Map(surgeryRefs().map((ref) => [`${ref.kind}/${ref.slug}`, ref]));
    const paths = expected.flatMap((row) => {
      const ref = refs.get(`${row.kind}/${row.slug}`);
      return ref === undefined ? [] : [surgeryPath(ref)];
    });
    const table = html.split('id="common-caption"')[1]?.split('</table>')[0] ?? '';
    expect([...table.matchAll(/href="(\/surgery\/[^"]+)"/g)].map((m) => m[1])).toEqual(paths);
    expect(paths).toHaveLength(COMMON_COUNT);
    const cells = elementsOf(`<table>${table}</table>`, 'td').map((cell) => cell.text);
    expect(cells).toHaveLength(COMMON_COUNT * 3);
    const hospitals = cells.filter((_, i) => i % 3 === 2);
    expect(hospitals).toEqual(expected.map((row) => formatCount(row.hospitals)));
    const surgeries = cells.filter((_, i) => i % 3 === 1);
    expect(surgeries.every((c) => /^[\d,]+ surgeries$/.test(c))).toBe(true);
    expect(textsOf(html, 'c-plain-table__stamp')[0]).toMatch(
      /\d{4}–\d{2}, released \d{1,2} \w+ \d{4}/,
    );
    expect(html.includes('c-figure')).toBe(false);
  });

  it('gives one row for each state, linked, with figures computed from the dist', () => {
    const table = html.split('id="states-caption"')[1]?.split('</table>')[0] ?? '';
    const rows = elementsOf(`<table>${table}</table>`, 'tr').filter((row) => row.text !== '');
    const cells = elementsOf(`<table>${table}</table>`, 'td').map((cell) => cell.text);
    const files = stateFiles();
    expect(cells).toHaveLength(files.length * 4);
    expect(rows.length).toBeGreaterThanOrEqual(files.length);
    const refs = surgeryRefs();
    for (const [i, file] of files.entries()) {
      const reporting = readHospitalIndex().filter(
        (h) => h.state === file.state && readHospital(h.slug).surgeries.some((s) => !s.stale),
      ).length;
      const medians = file.surgeries.flatMap((s) =>
        s.kind === 'procedure' && s.measures.median_wait?.state === 'published'
          ? [{ wait: s.measures.median_wait.value, slug: s.slug }]
          : [],
      );
      const waits = medians.map((m) => m.wait);
      const named = (wait: number): string[] =>
        medians
          .filter((m) => m.wait === wait)
          .flatMap((m) => refs.filter((r) => r.kind === 'procedure' && r.slug === m.slug))
          .map((r) =>
            fill(t.state_extreme, { wait: formatDays(wait), surgery: midSentence(r.name) }),
          );
      const [hospitals, types, shortest, longest] = cells.slice(i * 4, i * 4 + 4);
      expect(table).toContain(`href="${statePath(file.state)}"`);
      expect(hospitals).toBe(formatCount(reporting));
      expect(types).toBe(formatCount(medians.length));
      expect(named(Math.min(...waits))).toContain(shortest);
      expect(named(Math.max(...waits))).toContain(longest);
    }
    expect(textsOf(html, 'c-plain-table__stamp')).toHaveLength(2);
  });

  it('gives the state and urgency counts the surgery counts period and release the copy states', () => {
    expect(statesStamp()).toEqual(surgeryStamp());
    expect(urgencyStamp()).toEqual(surgeryStamp());
  });

  it('says each release once, and one sentence for each scope', () => {
    const stamps = homeStamps(t);
    const { release } = surgeryStamp();
    const shared =
      surgeryStamp().period === hospitalStamp().period && release === hospitalStamp().release;
    expect(main).toContain(stamps);
    expect(stamps.split(release).length - 1).toBe(shared ? 1 : 2);
    const sentences = stamps.split('. ');
    expect(new Set(sentences).size).toBe(sentences.length);
    const differ = homeStamps(
      t,
      { period: '2024–25', release: '19 August 2026' },
      { period: '2023–24', release: '1 July 2025' },
    );
    expect(differ).toContain(
      fill(t.hospitals_stamp, { period: '2023–24', release: '1 July 2025' }),
    );
    expect(differ).not.toContain(t.stamp_shared.slice(0, 20));
  });

  it('keeps a capital on a proper noun and on an acronym, and lowers a plain first word', () => {
    expect(midSentence("Dupuytren's contracture surgery")).toBe("Dupuytren's contracture surgery");
    expect(midSentence("Bartholin's abscess drainage")).toBe("Bartholin's abscess drainage");
    expect(midSentence('ACL reconstruction')).toBe('ACL reconstruction');
    expect(midSentence('LLETZ procedure')).toBe('LLETZ procedure');
    expect(midSentence('Hip replacement')).toBe('hip replacement');
    expect(midSentence('Out-turned eyelid repair')).toBe('out-turned eyelid repair');
    expect(midSentence('Tonsillectomy')).toBe('tonsillectomy');
    for (const ref of surgeryRefs()) {
      const lowered = midSentence(ref.name);
      const first = ref.name.split(' ')[0] ?? '';
      const proper = /[A-Z].*[A-Z]|'|’/.test(first);
      expect([ref.name, lowered === ref.name]).toEqual([ref.name, proper]);
      expect(lowered.slice(1)).toBe(ref.name.slice(1));
    }
  });

  it('states the private hospital exclusion, the safety block once and the passport once', () => {
    expect(main).toContain(t.exclusion);
    expect((html.match(/class="c-passport"/g) ?? []).length).toBe(1);
    expect(html.match(/id="[a-z]+-safety-heading"/g) ?? []).toHaveLength(1);
  });

  it('carries the compare search once, with its fallback, one results mount and one module script', () => {
    expect(html.match(/<form[ >]/g)).toHaveLength(1);
    expect(html.match(/class="c-tool__form js-tool-form"/g)).toHaveLength(1);
    expect(html.match(/js-tool-fallback/g)).toHaveLength(1);
    expect(html.match(/js-tool-results/g)).toHaveLength(1);
    expect(html.match(/<input[ >]/g)).toHaveLength(2);
    expect(html.match(/<script type="module"/g)).toHaveLength(1);
    expect(html.match(/<section[^>]*\sdata-tool/g)).toHaveLength(1);
    const fallback = html.split('js-tool-fallback')[1]?.split('</nav>')[0] ?? '';
    expect(hrefs(fallback)).toEqual(['/surgery/', '/hospitals/', '/state/']);
    expect(html).toContain('<section class="c-band c-home-screen" aria-labelledby="home-heading"');
    expect(html).not.toContain('c-compare-bar');
    expect(hrefs(html)).toContain('/compare/');
  });

  it('ships no event handler and no javascript address', () => {
    expect(/\son[a-z]+=|javascript:/i.test(withoutSiteScripts(html))).toBe(false);
    expect(/<script(?![^>]*type="module")/i.test(withoutSiteScripts(html))).toBe(false);
  });

  it('opens main with the band, which holds the h1 and the lede before the search', () => {
    const inMain = html.split('<main')[1] ?? '';
    const band = inMain.split('<section class="c-band c-home-screen"')[1] ?? '';
    expect(inMain.indexOf('<section class="c-band c-home-screen"')).toBeLessThan(
      inMain.indexOf('<h1'),
    );
    expect(inMain.indexOf('<h1')).toBeLessThan(inMain.indexOf('<p class="c-band__lede">'));
    expect(band.indexOf('<h1')).toBeGreaterThan(-1);
    expect(band.indexOf('<h1')).toBeLessThan(band.indexOf('<form'));
    expect(text(band.split('</h1>')[1]?.split('</p>')[0] ?? '')).toBe(t.lede);
    expect(inMain).toContain('class="o-wrap o-wrap--bleed"');
  });

  it('names the same figures and names as the first rows of the longest-waits pages', () => {
    const tiles = textsOf(html, 'c-proof__text');
    const figures = textsOf(html, 'c-proof__figure');
    const links = elementsOf(html, 'a').filter((a) => a.classes.has('c-proof__link'));
    const longest = longestEntries(1)[0];
    const border = borderPairs(1)[0];
    const move = stateMoves()[0];
    const { period } = surgeryStamp();
    const { previous } = movePeriods();
    // The longest-waits page counts its rows with ties at the last rank, so the link does too.
    const longestCount = longestEntries().length;
    const expected: { figure: string; text: string; link: string; path: string }[] = [];
    if (longest !== undefined) {
      const parts = formatDayParts(longest.figure.value);
      expected.push({
        figure: `${parts.amount} ${parts.unit}`,
        text: fill(t.proof_longest, {
          surgery: longest.ref.name,
          hospital: longest.row.name,
          period,
        }),
        link: fill(t.proof_longest_link, { count: formatCount(longestCount) }),
        path: LONGEST_PATH,
      });
    }
    if (border !== undefined) {
      const parts = formatDayParts(border.difference);
      expected.push({
        figure: `${parts.amount} ${parts.unit}`,
        text: fill(t.proof_border, {
          surgery: midSentence(border.ref.name),
          days: formatDays(border.difference),
          distance: formatKilometres(Math.round(border.km)),
          from_hospital: border.from.row.name,
          from_state: stateName(border.from.row.state),
          to_hospital: border.to.row.name,
          to_state: stateName(border.to.row.state),
          period,
        }),
        link: t.proof_border_link,
        path: BORDER_PATH,
      });
    }
    if (move !== undefined && move.change !== 0) {
      const parts = formatDayParts(move.from.value, move.to.value);
      expected.push({
        figure: `${parts.amount} ${parts.unit}`,
        text: fill(move.change > 0 ? t.proof_move_up : t.proof_move_down, {
          surgery: move.ref.name,
          state: stateName(move.state),
          previous,
          period,
        }),
        link: t.proof_move_link,
        path: CHANGES_PATH,
      });
    }
    expect(expected.length).toBeGreaterThan(0);
    expect(tiles).toEqual(expected.map((e) => e.text));
    expect(figures).toEqual(expected.map((e) => e.figure));
    expect(links.map((a) => a.text)).toEqual(expected.map((e) => e.link));
    const list = html.split('c-proof__list')[1]?.split('</ul>')[0] ?? '';
    expect(hrefs(list)).toEqual(expected.map((e) => e.path));
    const heading = textsOf(html, 'u-visually-hidden')[0];
    expect(heading).toBe(
      [t.proof_heading_one, t.proof_heading_two, t.proof_heading_three][expected.length - 1],
    );
    expect(html.includes('c-figure')).toBe(false);
  });

  it('puts the unit of a proof figure in one small span and never an arrow', () => {
    const figures = textsOf(html, 'c-proof__figure');
    expect(figures.every((f) => /^[\d,]+( to [\d,]+)? days?$/.test(f))).toBe(true);
    expect(html.match(/class="c-proof__unit"/g)).toHaveLength(figures.length);
    expect(/[→↑↓]/.test(html.split('c-proof__list')[1] ?? '')).toBe(false);
  });

  it('shows each start card count as the counts of the dist, in the card note', () => {
    const counts = homeCounts();
    expect(textsOf(html, 'c-starts__count')).toEqual([
      formatCount(counts.surgeries),
      formatCount(counts.hospitals),
      formatCount(counts.states),
      formatCount(counts.categories),
    ]);
    const cards = textsOf(html, 'c-starts__item');
    expect(cards).toHaveLength(5);
    expect(cards.some((c) => c.includes(t.specialty_note))).toBe(true);
    const starts = html.split('class="c-starts"')[1]?.split('</ul>')[0] ?? '';
    expect(hrefs(starts)).toEqual([
      '/surgery/',
      '/specialty/',
      '/hospitals/',
      '/state/',
      '/urgency/',
    ]);
  });

  it('says the release stamp once, and keeps one safety heading and one passport', () => {
    const stamps = homeStamps(t);
    expect(html.split(stamps).length - 1).toBe(1);
    expect(html.match(/id="[a-z]+-safety-heading"/g)).toHaveLength(1);
    expect(html.match(/class="c-passport"/g)).toHaveLength(1);
  });

  it('orders the body as the band, the results, the proof, the stamp, the facts and the start cards', () => {
    const order = [
      'class="c-band c-home-screen"',
      'js-tool-results',
      'class="c-proof ',
      homeStamps(t),
      'id="about-heading"',
      'id="start-heading"',
      'id="common-heading"',
      'id="states-heading"',
      'id="urgency-heading"',
      'id="exclusion-heading"',
      'home-safety-heading',
      'class="c-passport"',
    ];
    const at = order.map((needle) => html.indexOf(needle));
    expect(at.every((n) => n > -1)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('puts the sentence the band leads with ahead of the longer account of the site', () => {
    expect(main.indexOf(t.lede)).toBeLessThan(
      main.indexOf(fill(t.about_lede, { period: surgeryStamp().period })),
    );
  });

  it('marks what only the JavaScript-off page shows, so the twin leaves it out', () => {
    expect(html).toMatch(
      /class="c-band__fallback js-tool-fallback" aria-label="[^"]+" data-twin-skip/,
    );
  });

  it('prints the whole page before a result and hides each section once a result shows', () => {
    const screen = html.match(/class="[^"]*c-home-screen[^"]*"/g) ?? [];
    expect(screen.length).toBeGreaterThanOrEqual(6);
    expect(html).not.toMatch(/c-tool__safety[^"]*c-home-screen|c-home-screen[^"]*c-tool__safety/);
    expect(html.split('js-tool-results')[1]?.split('>')[0] ?? '').not.toContain('c-home-screen');
  });
});
