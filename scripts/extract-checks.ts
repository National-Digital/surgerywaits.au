import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';

// The gate runs trafilatura 2.3.1 and Mozilla Readability 0.6.0 over built pages. A template's keep
// rate is the share of the words in the runs of text in <main> that an extractor returns, summed
// over the template's sampled pages. A run is one text node of at least minWords words, outside the
// chrome selectors. Each field a page renders (heading, lede, release date, table row, chart caption)
// must also appear in the output of both extractors.

const EXTRACTORS = ['trafilatura', 'readability'] as const;
type Extractor = (typeof EXTRACTORS)[number];
const LABEL: Record<Extractor, string> = {
  trafilatura: 'trafilatura 2.3.1',
  readability: 'Readability 0.6.0',
};

interface TemplateConfig {
  name: string;
  floor: number;
  // A path with * for one path segment; without one it names a single page.
  path: string;
  // The lowest score any one sampled page may reach, on either extractor.
  pageFloor: number;
  // A template whose pages are not built yet passes until they are, and is held to its floor after.
  // Under strict it must have pages, unless it is also pending.
  optional?: boolean;
  // Sampled pages of this template may have no measured words; they fail otherwise.
  emptyOk?: boolean;
  // Pages that a later change adds: none is needed even under strict, and any that exist are held to the floors.
  pending?: boolean;
  // Set where the floor sits under the 95 or 90 the previous site was held to; the reason is then required.
  archiveFloor?: number;
  reason?: string;
}

interface FieldException {
  template: string;
  field: string;
  extractor: Extractor;
  reason: string;
  // Holds on the fixture build only; strict mode, which runs on the real build, ignores it.
  fixtureOnly?: boolean;
  // The most sampled pages the exception may cover; more fails, so it cannot spread unseen.
  maxPages?: number;
}

export interface Config {
  minWords: number;
  samplePerTemplate: number;
  chrome: string[];
  templates: TemplateConfig[];
  // Fields every sampled page of a template must render, so a renamed block fails instead of going unchecked.
  requiredFields: Record<string, string[]>;
  fieldExceptions: FieldException[];
}

const SKIP_TAGS = new Set(['script', 'style', 'template', 'noscript']);

// trafilatura joins neighbouring elements without a space, as in "Hospital48" and "earlierAlso".
const unfuse = (text: string): string =>
  text
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, '$1$3 $2$4');

// Lower case, quotes folded, anything but a letter or digit a space.
export const normalise = (text: string | null | undefined): string =>
  unfuse(text ?? '')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Whole words only, so a short field is not found inside a longer word.
const hasWords = (haystack: string, needle: string): boolean =>
  ` ${haystack} `.includes(` ${needle} `);

interface Run {
  norm: string;
  words: number;
}

export const mainRuns = (
  document: Document,
  chrome: string[],
  minWords: number,
): { runs: Run[]; rendered: string } | null => {
  const main = document.querySelector('main');
  if (main === null) {
    return null;
  }
  const excluded = new Set(chrome.flatMap((selector) => [...main.querySelectorAll(selector)]));
  const runs: Run[] = [];
  const all: string[] = [];
  const walker = document.createTreeWalker(main, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    let skip = false;
    let inChrome = false;
    for (
      let at = node.parentElement;
      at !== null && at !== main.parentElement;
      at = at.parentElement
    ) {
      skip ||= SKIP_TAGS.has(at.localName);
      inChrome ||= excluded.has(at);
    }
    if (skip) {
      continue;
    }
    all.push(node.nodeValue ?? '');
    const norm = normalise(node.nodeValue);
    const words = norm === '' ? 0 : norm.split(' ').length;
    if (!inChrome && words >= minWords) {
      runs.push({ norm, words });
    }
  }
  return { runs, rendered: normalise(all.join(' ')) };
};

export interface Field {
  field: string;
  text: string;
}

// The fields a page renders. Each must survive both extractors.
export const pageFields = (document: Document, chrome: string[]): Field[] => {
  const main = document.querySelector('main');
  const fields: Field[] = [];
  const add = (field: string, text: string | null | undefined): void => {
    if (normalise(text) !== '') {
      fields.push({ field, text: text ?? '' });
    }
  };
  if (main === null) {
    return fields;
  }
  const excluded = new Set(chrome.flatMap((selector) => [...main.querySelectorAll(selector)]));
  const visible = (el: Element): boolean => {
    for (let at: Element | null = el; at !== null && at !== main; at = at.parentElement) {
      if (excluded.has(at)) {
        return false;
      }
    }
    return true;
  };
  add('h1', main.querySelector('h1')?.textContent);
  add('lede', [...main.querySelectorAll('p')].find(visible)?.textContent);
  for (const small of main.querySelectorAll('small')) {
    if (small.textContent.includes('released')) {
      add('release date', small.textContent);
    }
  }
  for (const caption of main.querySelectorAll('figcaption')) {
    add('chart caption', caption.firstChild?.textContent);
  }
  for (const cell of main.querySelectorAll('tbody th[scope="row"]')) {
    add('table row', cell.textContent);
  }
  return fields;
};

export interface Extracted {
  trafilatura: string;
  readability: string;
}

export interface PageResult {
  path: string;
  template: string;
  words: number;
  kept: Record<Extractor, number>;
  fields: string[];
  drops: { field: string; extractor: Extractor; text: string }[];
}

export const measurePage = (
  html: string,
  path: string,
  template: string,
  extracted: Extracted,
  config: Config,
): PageResult => {
  const dom = new JSDOM(html, {
    url: 'https://surgerywaits.au/',
    virtualConsole: new VirtualConsole(),
  });
  try {
    const { document } = dom.window;
    const measured = mainRuns(document, config.chrome, config.minWords);
    if (measured === null) {
      throw new Error(`${path}: no <main> element`);
    }
    const text: Record<Extractor, string> = {
      trafilatura: normalise(extracted.trafilatura),
      readability: normalise(extracted.readability),
    };
    const kept = Object.fromEntries(
      EXTRACTORS.map((e) => [
        e,
        measured.runs
          .filter((run) => hasWords(text[e], run.norm))
          .reduce((sum, run) => sum + run.words, 0),
      ]),
    ) as Record<Extractor, number>;
    const found = pageFields(document, config.chrome);
    const drops: PageResult['drops'] = [];
    for (const { field, text: raw } of found) {
      const norm = normalise(raw);
      if (!hasWords(measured.rendered, norm)) {
        continue;
      }
      for (const e of EXTRACTORS) {
        if (!hasWords(text[e], norm)) {
          drops.push({ field, extractor: e, text: raw.trim() });
        }
      }
    }
    return {
      path,
      template,
      words: measured.runs.reduce((sum, run) => sum + run.words, 0),
      kept,
      fields: [...new Set(found.map((entry) => entry.field))].sort(),
      drops,
    };
  } finally {
    dom.window.close();
  }
};

interface Row {
  name: string;
  pages: number;
  floor: number;
  rate: Record<Extractor, number>;
  // The lowest single-page rate, for the owner's information; the floor applies to the template's rate.
  lowest: Record<Extractor, number>;
}

export interface Report {
  rows: Row[];
  failures: string[];
  excepted: string[];
  stale: string[];
  below: string[];
}

// Strict makes a stale exception a failure and requires every optional template that is not pending.
export const judge = (results: PageResult[], config: Config, strict = false): Report => {
  const report: Report = { rows: [], failures: [], excepted: [], stale: [], below: [] };
  const used = new Map<FieldException, Set<string>>();
  const exceptions = config.fieldExceptions.filter((x) => !(strict && x.fixtureOnly === true));
  for (const template of config.templates) {
    const pages = results.filter((result) => result.template === template.name);
    if (pages.length === 0 && template.optional === true) {
      if (strict && template.pending !== true) {
        report.failures.push(`${template.name}: no pages built, and strict requires them`);
      }
      continue;
    }
    const words = pages.reduce((sum, page) => sum + page.words, 0);
    const per = (e: Extractor): number[] =>
      pages.map((page) => (page.words === 0 ? 0 : (100 * page.kept[e]) / page.words));
    const rate = Object.fromEntries(
      EXTRACTORS.map((e) => [
        e,
        words === 0 ? 0 : (100 * pages.reduce((sum, page) => sum + page.kept[e], 0)) / words,
      ]),
    ) as Record<Extractor, number>;
    const lowest = Object.fromEntries(EXTRACTORS.map((e) => [e, Math.min(...per(e))])) as Record<
      Extractor,
      number
    >;
    if (template.archiveFloor !== undefined && template.floor < template.archiveFloor) {
      if (template.reason === undefined) {
        report.failures.push(
          `${template.name}: floor ${String(template.floor)} is under ${String(template.archiveFloor)} with no reason`,
        );
      } else {
        report.below.push(
          `${template.name}: floor ${String(template.floor)}, previously ${String(template.archiveFloor)}. ${template.reason}`,
        );
      }
    }
    report.rows.push({
      name: template.name,
      pages: pages.length,
      floor: template.floor,
      rate,
      lowest,
    });
    if (words === 0) {
      report.failures.push(`${template.name}: no pages or no <main> text measured`);
    }
    for (const e of EXTRACTORS) {
      if (words > 0 && rate[e] < template.floor) {
        report.failures.push(
          `${template.name}: ${LABEL[e]} keeps ${rate[e].toFixed(1)}% of <main> words, under the ${String(template.floor)}% floor`,
        );
      }
    }
    for (const page of pages) {
      if (page.words === 0 && template.emptyOk !== true && words > 0) {
        report.failures.push(`${page.path}: no <main> text measured`);
      }
      for (const e of EXTRACTORS) {
        const score = page.words === 0 ? 0 : (100 * page.kept[e]) / page.words;
        if (page.words > 0 && score < template.pageFloor) {
          report.failures.push(
            `${page.path}: ${LABEL[e]} keeps ${score.toFixed(1)}% of <main> words, under the ${String(template.pageFloor)}% page floor`,
          );
        }
      }
      for (const field of config.requiredFields[template.name] ?? []) {
        if (!page.fields.includes(field)) {
          report.failures.push(`${page.path}: renders no ${field}`);
        }
      }
      const grouped = new Map<string, PageResult['drops']>();
      for (const drop of page.drops) {
        const key = `${drop.field}\n${drop.extractor}`;
        grouped.set(key, [...(grouped.get(key) ?? []), drop]);
      }
      for (const drops of grouped.values()) {
        const [drop] = drops;
        if (drop === undefined) {
          continue;
        }
        const exception = exceptions.find(
          (x) =>
            x.template === template.name &&
            x.field === drop.field &&
            x.extractor === drop.extractor,
        );
        if (exception === undefined) {
          const more = drops.length > 1 ? ` (and ${String(drops.length - 1)} more)` : '';
          report.failures.push(
            `${page.path}: ${LABEL[drop.extractor]} drops the ${drop.field}: "${drop.text.slice(0, 100)}"${more}`,
          );
        } else {
          used.set(exception, (used.get(exception) ?? new Set<string>()).add(page.path));
        }
      }
    }
  }
  for (const exception of exceptions) {
    const pages = used.get(exception);
    if (pages === undefined) {
      const stale = `${exception.template}: ${LABEL[exception.extractor]} now keeps the ${exception.field} on every sampled page; delete the exception`;
      report.stale.push(stale);
      if (strict) {
        report.failures.push(stale);
      }
    } else {
      const bound =
        exception.maxPages === undefined ? '' : ` of at most ${String(exception.maxPages)}`;
      const names = [...pages].sort();
      const shown = names.slice(0, 3).join(', ') + (names.length > 3 ? ', and more' : '');
      report.excepted.push(
        `${exception.template}: ${LABEL[exception.extractor]} drops the ${exception.field} on ${String(pages.size)}${bound} sampled page(s), such as ${shown}. ${exception.reason}`,
      );
      if (exception.maxPages !== undefined && pages.size > exception.maxPages) {
        report.failures.push(
          `${exception.template}: the ${exception.field} exception for ${LABEL[exception.extractor]} covers ${String(pages.size)} pages, over its limit of ${String(exception.maxPages)}`,
        );
      }
    }
  }
  return report;
};

export const markdown = (report: Report): string => {
  const pct = (n: number): string => `${n.toFixed(1)}%`;
  const section = (title: string, items: string[]): string[] =>
    items.length > 0 ? ['', `### ${title}`, '', ...items.map((item) => `- ${item}`)] : [];
  return [
    `## Extractability (trafilatura, Readability): ${report.failures.length > 0 ? 'failed' : 'passed'}`,
    '',
    '| Template | Pages | trafilatura | Readability | Lowest page | Floor |',
    '|---|---|---|---|---|---|',
    ...report.rows.map(
      (t) =>
        `| ${t.name} | ${String(t.pages)} | ${pct(t.rate.trafilatura)} | ${pct(t.rate.readability)} | ${pct(Math.min(t.lowest.trafilatura, t.lowest.readability))} | ${String(t.floor)}% |`,
    ),
    ...section('Failures', report.failures),
    ...section('Stale exceptions', report.stale),
    ...section('Floors under the previous standard', report.below),
    ...section('Drops allowed by an exception', report.excepted),
    '',
  ].join('\n');
};

const pattern = (path: string): RegExp =>
  new RegExp(`^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`);

// Pages matching no template fail, so a new template cannot ship without a floor.
export const unmatched = (config: Config, paths: string[]): string[] => {
  const patterns = config.templates.map((t) => pattern(t.path));
  return paths.filter((path) => !patterns.some((re) => re.test(path)));
};

// Up to samplePerTemplate pages evenly spaced over the sorted paths, plus the first and the last: the same every run.
export const choosePages = (
  config: Config,
  paths: string[],
): { path: string; template: string }[] =>
  config.templates.flatMap((template) => {
    const re = pattern(template.path);
    const matches = paths.filter((path) => re.test(path));
    const take = Math.min(config.samplePerTemplate, matches.length);
    const at = new Set(
      Array.from({ length: take }, (_, i) => Math.floor((i * matches.length) / take)),
    );
    if (matches.length > 0) {
      at.add(0).add(matches.length - 1);
    }
    return [...at]
      .sort((a, b) => a - b)
      .map((i) => ({ path: matches[i] ?? '', template: template.name }));
  });

export interface Article {
  text: string;
}

// Text nodes of the returned article, one piece each, because textContent fuses neighbouring elements.
const nodeText = (html: string): string => {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  try {
    const { document } = dom.window;
    const walker = document.createTreeWalker(document.body, 4);
    const pieces: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      pieces.push(node.nodeValue ?? '');
    }
    return pieces.join(' ');
  } finally {
    dom.window.close();
  }
};

// The whole document with charThreshold 500, as the extractor is normally run.
export const readability = (html: string): Article => {
  const dom = new JSDOM(html, {
    url: 'https://surgerywaits.au/',
    virtualConsole: new VirtualConsole(),
  });
  try {
    const article = new Readability(dom.window.document, { charThreshold: 500 }).parse();
    return { text: nodeText(article?.content ?? '') };
  } finally {
    dom.window.close();
  }
};
