import { CONTENT_SIGNAL, NAMED_CRAWLERS } from './robots';
import {
  getAbout,
  getAgents,
  getDataPage,
  getGuidesIndex,
  getMethodology,
  getNavigation,
  getSite,
  label,
} from './content';
import type { ArticleSection } from './content-schema';
import { cacheControl } from '../../../worker/headers';
import { BROWSER_ORIGINS, MCP_CARD_PATH, MCP_PATH, PROTOCOL_VERSIONS } from '../../../worker/mcp';
import { SPECS } from '../../../worker/mcp-tools';
import { dataFacts, fillSections, fillText, methodologyFacts } from './article-pages';
import { readCredits } from './credits';
import { formatCount, formatDate, formatLicence, formatList } from './format';
import { guides } from './guides';
import { homeCounts } from './home-page';
import { surgeryStamp } from './index-pages';
import { builtLinks } from './links';
import { fill } from './slots';
import { SURFACES } from './surfaces';
import type { ListGroup, Listed } from './surfaces';

export const AGENTS_PATH = '/agents/';

// The page for general practitioners is a key page, so it sits with them and not under About.
const GP_PATH = '/gp/';

const abs = (path: string): string => new URL(path, getSite().url).href;

interface Line {
  label: string;
  path: string;
  note?: string;
}

const entry = ({ label: name, path, note }: Line): string =>
  `- [${name}](${abs(path)})${note === undefined ? '' : `: ${note}`}`;

// A listed file has its own note or one in agents.yaml, so a missing note fails the build.
const listedLine = ({ id, label: name, path, note: own }: Listed): Line => {
  const note = own ?? getAgents().llms.notes[id];
  if (note === undefined) {
    throw new Error(`no note for ${id} in agents.yaml`);
  }
  return { label: name, path, note };
};

const block = (heading: string, entries: readonly Line[]): string[] =>
  entries.length === 0 ? [] : [`## ${heading}`, '', ...entries.map(entry), ''];

// The surfaces name the files, so a file added to the registry reaches the router with no second list.
const surfaceEntries = (group: ListGroup): Line[] =>
  SURFACES.filter((surface) => surface.group === group).flatMap((surface) =>
    (surface.listed?.() ?? []).map(listedLine),
  );

export const agentFacts = (): Record<string, string> => ({
  site: getSite().name,
  content_signal: CONTENT_SIGNAL,
  crawlers: formatList([...NAMED_CRAWLERS]),
  data_cache: cacheControl('/data-api/index.json', 200) ?? '',
  page_cache: cacheControl('/', 200) ?? '',
  robots_cache: cacheControl('/robots.txt', 200) ?? '',
  mcp_path: MCP_PATH,
  mcp_card: MCP_CARD_PATH,
  mcp_versions: formatList([...PROTOCOL_VERSIONS]),
  mcp_tools: formatList(Object.keys(SPECS)),
  mcp_origins: formatList([...BROWSER_ORIGINS]),
});

// A page's own description is its note, so the router adds no wording of its own.
const notes = (): Record<string, string> => ({
  '/methodology/': getMethodology().description,
  '/guides/': getGuidesIndex().description,
  '/about/': getAbout().description,
  '/data/': getDataPage().description,
  [AGENTS_PATH]: getAgents().description,
});

const named = (links: { label: string; href: string }[]): Line[] =>
  links.map(({ label: name, href }) => {
    const note = notes()[href];
    return { label: name, path: href, ...(note === undefined ? {} : { note }) };
  });

export function llmsTxt(): string {
  const t = getAgents();
  const nav = getNavigation();
  const stamp = fill(getMethodology().stamp, surgeryStamp());
  const gp = nav.about.filter((link) => link.href === GP_PATH);
  const pages = named(builtLinks([...nav.site, nav.compare, ...gp]));
  const about = named(
    builtLinks([
      ...nav.about.filter((link) => link.href !== GP_PATH),
      { label: t.crumb, href: AGENTS_PATH },
    ]),
  );
  const guideEntries: Line[] = guides().map((g) => ({
    label: g.heading,
    path: g.path,
    note: g.summary,
  }));
  return [
    `# ${getSite().name}`,
    '',
    `> ${t.llms.summary}`,
    '',
    stamp,
    '',
    ...block(t.llms.heading_pages, pages),
    ...block(t.llms.heading_guides, guideEntries),
    ...block(t.llms.heading_about, about),
    ...block(t.llms.heading_data, surfaceEntries('data')),
    ...block(t.llms.heading_schemas, surfaceEntries('schemas')),
    ...block(t.llms.heading_site, surfaceEntries('site')),
  ].join('\n');
}

const sectionText = (section: ArticleSection, level: string): string[] => [
  `${level} ${section.heading}`,
  '',
  ...section.paragraphs.flatMap((p) => [p, '']),
  ...(section.items === undefined ? [] : [...section.items.map((i) => `- ${i}`), '']),
  ...(section.links === undefined
    ? []
    : [...section.links.map((l) => `- [${l.label}](${abs(l.href)})`), '']),
];

const article = (
  heading: string,
  lede: string,
  extra: string[],
  sections: ArticleSection[],
): string[] => [
  `## ${heading}`,
  '',
  lede,
  '',
  ...extra.flatMap((p) => [p, '']),
  ...sections.flatMap((s) => sectionText(s, '###')),
];

function creditLines(): string[] {
  return readCredits().flatMap((c) => [
    `- ${c.title}`,
    `  - ${label('passport_publisher')}: ${c.publisher.name} (${c.publisher.url})`,
    `  - ${label('passport_version')}: ${formatDate(c.version)}`,
    `  - ${label('passport_released')}: ${c.as_at === null ? label('passport_released_none') : formatDate(c.as_at)}`,
    `  - ${label('passport_licence')}: ${formatLicence(c.licence)}`,
    `  - ${label('passport_citation')}: ${c.citation}`,
    `  - ${c.dataset_url}`,
  ]);
}

export function llmsFullTxt(): string {
  const t = getAgents();
  const about = getAbout();
  const method = getMethodology();
  const data = getDataPage();
  const stamp = surgeryStamp();
  const { hospitals, surgeries } = homeCounts();
  const counts = { hospitals: formatCount(hospitals), surgeries: formatCount(surgeries) };
  const aboutFacts = { operator: getSite().operator.name };
  const methodFacts = methodologyFacts();
  return [
    `# ${getSite().name}`,
    '',
    `> ${t.llms.summary}`,
    `> ${t.llms.full_summary}`,
    '',
    ...article(
      about.heading,
      fillText(about.lede, aboutFacts),
      [],
      fillSections(about.sections, aboutFacts),
    ),
    ...article(
      method.heading,
      fillText(method.lede, methodFacts),
      [fill(method.stamp, stamp)],
      fillSections(method.sections, methodFacts),
    ),
    ...article(
      data.heading,
      data.lede,
      [fill(data.stamp, stamp), fill(data.counts, counts)],
      [...fillSections(data.sections, dataFacts()), ...fillSections(data.after, dataFacts())],
    ),
    `### ${label('passport_heading')}`,
    '',
    ...creditLines(),
    '',
  ].join('\n');
}
