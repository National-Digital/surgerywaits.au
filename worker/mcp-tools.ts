import { distanceKm } from '../site/src/lib/geo';
import { formatFigure, formatPeriod } from '../site/src/lib/format';
import type { Figure, Role } from '../site/src/lib/format';
import { SITE } from '../site/src/lib/robots';

const MAX_RADIUS_KM = 250;
const DEFAULT_RADIUS_KM = 120;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

// Reads one published data file by path; null when the build has no such file.
export type Reader = (path: string) => Promise<unknown>;

// A wrong or ambiguous answer the caller can fix, returned as a tool error and not a protocol fault.
export class ToolProblem extends Error {
  readonly candidates: unknown[] | undefined;
  constructor(message: string, candidates?: unknown[]) {
    super(message);
    this.candidates = candidates;
  }
}

// The data files a tool may read; the built test proves each one exists in the build.
export const FIXED_PATHS = [
  '/data-api/surgeries.json',
  '/data-api/hospitals.json',
  '/data-api/suburbs.json',
  '/data-api/credits.json',
] as const;
export const surgeryFile = (kind: string, slug: string): string =>
  `/data-api/surgeries/${kind}/${slug}.json`;

interface StringField {
  type: 'string';
  min: number;
  max: number;
  description: string;
}
interface NumberField {
  type: 'integer' | 'number';
  min: number;
  max: number;
  description: string;
}
type Field = StringField | NumberField;
export interface Spec {
  properties: Record<string, Field>;
  required: string[];
}

const surgeryField: StringField = {
  type: 'string',
  min: 2,
  max: 120,
  description: 'A surgery named as the source names it, or a word from it, such as "cataract".',
};
const stateField: StringField = {
  type: 'string',
  min: 2,
  max: 40,
  description:
    'A state or territory: NSW, Vic, Qld, WA, SA, Tas, ACT or NT, in any case, or its full name.',
};

export const SPECS: Record<string, Spec> = {
  surgerywaits_list_procedures: {
    properties: {
      query: {
        type: 'string',
        min: 0,
        max: 120,
        description: 'Words from the surgery name. Leave out for the full list.',
      },
    },
    required: [],
  },
  surgerywaits_get_wait: {
    properties: {
      procedure: surgeryField,
      hospital: {
        type: 'string',
        min: 2,
        max: 120,
        description: 'A public hospital name or slug. Leave out for a state or national figure.',
      },
      state: stateField,
    },
    required: ['procedure'],
  },
  surgerywaits_compare_hospitals: {
    properties: {
      procedure: surgeryField,
      locality: {
        type: 'string',
        min: 2,
        max: 80,
        description: 'A suburb or town name, such as "Armidale". A postcode is not accepted.',
      },
      state: stateField,
      radius_km: {
        type: 'number',
        min: 1,
        max: MAX_RADIUS_KM,
        description: `Travel distance in km. Default ${String(DEFAULT_RADIUS_KM)}.`,
      },
      limit: {
        type: 'integer',
        min: 1,
        max: MAX_LIMIT,
        description: `How many hospitals to list. Default ${String(DEFAULT_LIMIT)}.`,
      },
    },
    required: ['procedure', 'locality'],
  },
  surgerywaits_explain_urgency: {
    properties: {
      category: {
        type: 'string',
        min: 1,
        max: 20,
        description: '1, 2 or 3, or urgent, semi-urgent or non-urgent.',
      },
    },
    required: ['category'],
  },
};

export function inputSchema(spec: Spec): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(spec.properties).map(([name, field]) => [
        name,
        {
          type: field.type,
          description: field.description,
          ...(field.type === 'string'
            ? { minLength: field.min, maxLength: field.max }
            : { minimum: field.min, maximum: field.max }),
        },
      ]),
    ),
    required: spec.required,
    additionalProperties: false,
  };
}

// Why arguments are invalid, or undefined; any key the tool does not declare is refused.
export function argumentProblem(spec: Spec, args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return 'arguments must be an object';
  }
  const given = args as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    if (!Object.hasOwn(spec.properties, name)) {
      return `unknown argument ${JSON.stringify(name).slice(0, 40)}`;
    }
  }
  for (const name of spec.required) {
    if (!Object.hasOwn(given, name)) {
      return `missing argument ${name}`;
    }
  }
  for (const [name, field] of Object.entries(spec.properties)) {
    const value = given[name];
    if (value === undefined) {
      continue;
    }
    if (field.type === 'string') {
      if (typeof value !== 'string' || value.length < field.min || value.length > field.max) {
        return `${name} must be a string of ${String(field.min)} to ${String(field.max)} characters`;
      }
    } else if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (field.type === 'integer' && !Number.isInteger(value)) ||
      value < field.min ||
      value > field.max
    ) {
      return `${name} must be a${field.type === 'integer' ? 'n integer' : ' number'} from ${String(field.min)} to ${String(field.max)}`;
    }
  }
  return undefined;
}

/* ---- the published files, as far as the tools read them ---- */

interface WireFigure {
  state: string;
  value?: number;
  reason?: string;
  period: string;
  release: string;
}
interface Measure {
  figure: WireFigure;
}
type Measures = Partial<Record<Role, Measure>>;
interface Row {
  code: string;
  slug: string;
  name: string;
  state: string;
  closed: boolean;
  measures: Measures;
}
interface Surgery {
  kind: string;
  slug: string;
  name: string;
  period: string;
  release: string;
  sources: string[];
  benchmarks: {
    national: Record<string, WireFigure> | null;
    states: { state: string; measures: Record<string, WireFigure> }[];
  };
  hospitals: Row[];
}
interface Index {
  surgeries: { kind: string; slug: string; name: string; hospitals: number }[];
}
interface Credits {
  sources: {
    slug: string;
    title: string;
    attribution: string;
    licence: string;
    dataset_url: string;
  }[];
}
interface Hospitals {
  hospitals: {
    code: string;
    slug: string;
    name: string;
    state: string;
    closed: boolean;
    latitude: number | null;
    longitude: number | null;
  }[];
}
interface Suburbs {
  suburbs: [string, string, string, number, number][];
}

const STATES = ['NSW', 'Vic', 'Qld', 'WA', 'SA', 'Tas', 'ACT', 'NT'] as const;
const STATE_NAMES: Record<string, string> = {
  'new south wales': 'NSW',
  victoria: 'Vic',
  queensland: 'Qld',
  'western australia': 'WA',
  'south australia': 'SA',
  tasmania: 'Tas',
  'australian capital territory': 'ACT',
  'northern territory': 'NT',
};

// The wording the site gives each urgency category. A test holds it equal to the site content.
export const CATEGORIES = [
  {
    number: 1,
    word: 'urgent',
    slug: 'urgent-elective-surgery',
    within: '30 days',
    meaning: 'It is for a condition that could get worse quickly enough to become an emergency.',
  },
  {
    number: 2,
    word: 'semi-urgent',
    slug: 'semi-urgent-elective-surgery',
    within: '90 days',
    meaning:
      'It is for a condition that causes some pain, dysfunction or disability. The condition is unlikely to get worse quickly or become an emergency.',
  },
  {
    number: 3,
    word: 'non-urgent',
    slug: 'non-urgent-elective-surgery',
    within: '365 days',
    meaning:
      'It is for a condition that causes little or no pain, dysfunction or disability. The condition is unlikely to get worse quickly and is not expected to become an emergency.',
  },
] as const;

const NINETIETH =
  'The data has the median wait, the share who waited more than 365 days and the number of surgeries. It has no 90th percentile wait.';
const RANKING =
  'Ordered by the published median wait, shortest first. Only hospitals with a published median for the latest period are ranked. This orders one published number. It does not judge quality and is not clinical advice.';
const DISTANCE = 'Straight-line distance from the suburb centre, to the nearest kilometre.';
const SHARE_NOTE = 'A share is a fraction of patients: 0.115 is 11.5%.';

const fold = (value: string): string => value.trim().toLowerCase().replace(/\s+/gu, ' ');
const words = (value: string): string[] =>
  fold(value)
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);

async function need<T>(read: Reader, path: string): Promise<T> {
  const found = await read(path);
  if (found === null) {
    throw new Error(`no data at ${path}`);
  }
  return found as T;
}

// A figure with its words and its reason. A withheld figure never carries a number.
interface FigureView {
  status: string;
  value: number | null;
  reason?: string;
  display: string;
  period: string;
  release: string;
}
interface SourceView {
  period: string;
  release_date: string;
  credits: { title: string; attribution: string; licence: string; dataset_url: string }[];
}
interface SurgeryView {
  slug: string;
  kind: string;
  name: string;
}
interface Summary extends SurgeryView {
  hospitals_reporting: number;
  data_url: string;
}
export interface ListAnswer {
  surgeries: Summary[];
  total: number;
  message?: string;
  scope: string;
}
export interface WaitAnswer {
  scope: string;
  surgery: SurgeryView;
  ninetieth_percentile: string;
  share_note: string;
  data_url: string;
  source: SourceView;
  median_wait: FigureView;
  waited_more_than_365_days: FigureView;
  surgeries: FigureView;
  hospital?: { name: string; state: string; slug: string; closed: boolean };
  state?: string;
  page_url?: string;
}
interface HospitalView {
  name: string;
  state: string;
  distance_km: number;
  median_wait: FigureView;
  waited_more_than_365_days: FigureView;
  surgeries: FigureView;
  page_url: string;
}
export interface CompareAnswer {
  surgery: SurgeryView;
  from: { locality: string; state: string };
  radius_km: number;
  distance_note: string;
  ranking_basis: string;
  share_note: string;
  hospitals_within_radius: number;
  ranked_total: number;
  ranked: (HospitalView & { rank: number })[];
  not_ranked_total: number;
  not_ranked: (HospitalView & { reason: string | null })[];
  ninetieth_percentile: string;
  data_url: string;
  source: SourceView;
}
export interface UrgencyAnswer {
  category: number;
  name: string;
  source_name: string;
  recommended_within: string;
  meaning: string;
  who_decides: string;
  hospitals_listed: number;
  page_url: string;
  data_url: string;
  source: SourceView;
}

function figureOut(role: Role, figure: WireFigure | undefined, stamp: Surgery | Stamp): FigureView {
  if (figure === undefined) {
    return {
      status: 'not_reported',
      value: null,
      reason: 'not_reported_by_source',
      display: 'not reported',
      period: stamp.period,
      release: stamp.release,
    };
  }
  const shown = figure as Figure;
  if (shown.state === 'published') {
    return {
      status: 'published',
      value: shown.value,
      display: formatFigure(role, shown),
      period: shown.period,
      release: shown.release,
    };
  }
  return {
    status: shown.state,
    value: null,
    reason: shown.reason,
    display: formatFigure(role, shown),
    period: shown.period,
    release: shown.release,
  };
}
interface Stamp {
  period: string;
  release: string;
}

async function source(read: Reader, slugs: string[], stamp: Stamp): Promise<SourceView> {
  const credits = await need<Credits>(read, '/data-api/credits.json');
  return {
    period: formatPeriod(stamp.period),
    release_date: stamp.release,
    credits: credits.sources
      .filter((entry) => slugs.includes(entry.slug))
      .map((entry) => ({
        title: entry.title,
        attribution: entry.attribution,
        licence: entry.licence,
        dataset_url: entry.dataset_url,
      })),
  };
}

function resolveState(value: string): string {
  const needle = fold(value).replace(/\./gu, '');
  const found = STATES.find((code) => code.toLowerCase() === needle) ?? STATE_NAMES[needle];
  if (found === undefined) {
    throw new ToolProblem(
      'That is not an Australian state or territory.',
      STATES.map((code) => ({ code })),
    );
  }
  return found;
}

const summary = (entry: Index['surgeries'][number]): Summary => ({
  slug: entry.slug,
  kind: entry.kind,
  name: entry.name,
  hospitals_reporting: entry.hospitals,
  data_url: `${SITE}${surgeryFile(entry.kind, entry.slug)}`,
});

const listable = (index: Index): Index['surgeries'] =>
  index.surgeries.filter((entry) => entry.kind !== 'urgency');

function matches(entries: Index['surgeries'], query: string): Index['surgeries'] {
  const needles = words(query);
  return entries.filter((entry) => {
    const have = words(`${entry.name} ${entry.slug}`);
    return needles.every((needle) => have.some((word) => word.startsWith(needle)));
  });
}

async function resolveSurgery(read: Reader, query: string): Promise<Index['surgeries'][number]> {
  const index = await need<Index>(read, '/data-api/surgeries.json');
  const all = listable(index);
  const needle = fold(query);
  const exact = all.filter((entry) => entry.slug === needle || fold(entry.name) === needle);
  const found = exact.length > 0 ? exact : matches(all, query);
  if (found.length === 1 && found[0] !== undefined) {
    return found[0];
  }
  if (found.length > 1) {
    throw new ToolProblem(
      'More than one surgery matches. Call again with one of these slugs.',
      found.slice(0, 15).map(summary),
    );
  }
  throw new ToolProblem(
    'No surgery matches that. Call surgerywaits_list_procedures with no query for the full list.',
  );
}

export async function listProcedures(read: Reader, input: { query?: string }): Promise<ListAnswer> {
  const index = await need<Index>(read, '/data-api/surgeries.json');
  const all = listable(index);
  const query = input.query?.trim() ?? '';
  const found = query === '' ? all : matches(all, query);
  return {
    surgeries: found.slice(0, 200).map(summary),
    total: found.length,
    ...(found.length === 0 ? { message: 'No surgery matches that. Try another word.' } : {}),
    scope: 'Planned surgery at public hospitals. Private hospitals are not included.',
  };
}

const hospitalMatches = <T extends { slug: string; name: string; state: string }>(
  rows: T[],
  query: string,
  state: string | null,
): T[] => {
  const needle = fold(query);
  const inState = rows.filter((row) => state === null || row.state === state);
  const exact = inState.filter((row) => row.slug === needle || fold(row.name) === needle);
  return exact.length > 0 ? exact : inState.filter((row) => fold(row.name).includes(needle));
};

export async function getWait(
  read: Reader,
  input: { procedure: string; hospital?: string; state?: string },
): Promise<WaitAnswer> {
  const entry = await resolveSurgery(read, input.procedure);
  const surgery = await need<Surgery>(read, surgeryFile(entry.kind, entry.slug));
  const state = input.state === undefined ? null : resolveState(input.state);
  const base = {
    surgery: { slug: surgery.slug, kind: surgery.kind, name: surgery.name },
    ninetieth_percentile: NINETIETH,
    share_note: SHARE_NOTE,
    data_url: `${SITE}${surgeryFile(surgery.kind, surgery.slug)}`,
    source: await source(read, surgery.sources, surgery),
  };
  const out = (
    scope: Partial<WaitAnswer> & { scope: string },
    measures: Record<string, WireFigure> | Measures,
  ): WaitAnswer => {
    const pick = (role: Role): WireFigure | undefined => {
      const item = (measures as Record<string, WireFigure | Measure | undefined>)[role];
      return item !== undefined && 'figure' in item ? item.figure : item;
    };
    return {
      ...base,
      ...scope,
      median_wait: figureOut('median_wait', pick('median_wait'), surgery),
      waited_more_than_365_days: figureOut('long_wait', pick('long_wait'), surgery),
      surgeries: figureOut('volume', pick('volume'), surgery),
    };
  };

  if (input.hospital !== undefined) {
    const found = hospitalMatches(surgery.hospitals, input.hospital, state);
    if (found.length > 1) {
      throw new ToolProblem(
        'More than one hospital matches. Call again with one of these slugs.',
        found.slice(0, 10).map(({ name, state: where, slug }) => ({ name, state: where, slug })),
      );
    }
    const row = found[0];
    if (row === undefined) {
      const known = hospitalMatches(
        (await need<Hospitals>(read, '/data-api/hospitals.json')).hospitals,
        input.hospital,
        state,
      );
      throw new ToolProblem(
        known.length > 0
          ? `${known.map((h) => h.name).join(', ')} has no figure for ${surgery.name}.`
          : 'No public hospital matches that name.',
      );
    }
    return out(
      {
        scope: 'hospital',
        hospital: { name: row.name, state: row.state, slug: row.slug, closed: row.closed },
        page_url: `${SITE}/hospital/${row.slug}/`,
      },
      row.measures,
    );
  }
  if (state !== null) {
    const found = surgery.benchmarks.states.find((candidate) => candidate.state === state);
    return out({ scope: 'state', state }, found?.measures ?? {});
  }
  return out({ scope: 'national' }, surgery.benchmarks.national ?? {});
}

async function resolveLocality(
  read: Reader,
  query: string,
  state: string | null,
): Promise<{ name: string; state: string; latitude: number; longitude: number }> {
  if (/\d/u.test(query)) {
    throw new ToolProblem('Postcodes are not supported. Give the suburb or town name.');
  }
  const { suburbs } = await need<Suburbs>(read, '/data-api/suburbs.json');
  const base = (name: string): string => fold(name.replace(/\s*\(.*\)\s*$/u, ''));
  const needle = fold(query);
  const pool = suburbs.filter((row) => state === null || row[2] === state);
  const exact = pool.filter((row) => base(row[1]) === needle);
  const found = exact.length > 0 ? exact : pool.filter((row) => base(row[1]).startsWith(needle));
  if (found.length === 1 && found[0] !== undefined) {
    const [, name, where, latitude, longitude] = found[0];
    return { name, state: where, latitude, longitude };
  }
  if (found.length === 0) {
    throw new ToolProblem('No suburb or town matches that. Check the spelling.');
  }
  throw new ToolProblem(
    'More than one suburb or town matches. Call again with the exact name, and the state.',
    found.slice(0, 10).map((row) => ({ locality: row[1], state: row[2] })),
  );
}

export async function compareHospitals(
  read: Reader,
  input: {
    procedure: string;
    locality: string;
    state?: string;
    radius_km?: number;
    limit?: number;
  },
): Promise<CompareAnswer> {
  const entry = await resolveSurgery(read, input.procedure);
  const state = input.state === undefined ? null : resolveState(input.state);
  const origin = await resolveLocality(read, input.locality, state);
  const radius = input.radius_km ?? DEFAULT_RADIUS_KM;
  const limit = input.limit ?? DEFAULT_LIMIT;
  const surgery = await need<Surgery>(read, surgeryFile(entry.kind, entry.slug));
  const places = new Map(
    (await need<Hospitals>(read, '/data-api/hospitals.json')).hospitals.map((h) => [h.code, h]),
  );
  const near = surgery.hospitals.flatMap((row) => {
    const place = places.get(row.code);
    if (place === undefined || place.latitude === null || place.longitude === null) {
      return [];
    }
    const km = distanceKm(origin, { latitude: place.latitude, longitude: place.longitude });
    return km <= radius ? [{ row, km: Math.round(km) }] : [];
  });
  const median = (row: Row): WireFigure | undefined => row.measures.median_wait?.figure;
  const reason = (row: Row): string | null => {
    const figure = median(row);
    if (row.closed) {
      return 'closed';
    }
    if (figure?.state !== 'published') {
      return figure === undefined ? 'not_reported' : figure.state;
    }
    return figure.period === surgery.period ? null : 'older_period';
  };
  const describe = (found: (typeof near)[number]): HospitalView => ({
    name: found.row.name,
    state: found.row.state,
    distance_km: found.km,
    median_wait: figureOut('median_wait', median(found.row), surgery),
    waited_more_than_365_days: figureOut(
      'long_wait',
      found.row.measures.long_wait?.figure,
      surgery,
    ),
    surgeries: figureOut('volume', found.row.measures.volume?.figure, surgery),
    page_url: `${SITE}/hospital/${found.row.slug}/`,
  });
  const value = (found: (typeof near)[number]): number => median(found.row)?.value ?? 0;
  const ranked = near
    .filter((found) => reason(found.row) === null)
    .sort((a, b) => value(a) - value(b) || a.km - b.km || a.row.name.localeCompare(b.row.name));
  const unranked = near
    .filter((found) => reason(found.row) !== null)
    .sort((a, b) => a.km - b.km || a.row.name.localeCompare(b.row.name));
  return {
    surgery: { slug: surgery.slug, kind: surgery.kind, name: surgery.name },
    from: { locality: origin.name, state: origin.state },
    radius_km: radius,
    distance_note: DISTANCE,
    ranking_basis: RANKING,
    share_note: SHARE_NOTE,
    hospitals_within_radius: near.length,
    ranked_total: ranked.length,
    ranked: ranked.slice(0, limit).map((found) => ({
      rank: 1 + ranked.filter((other) => value(other) < value(found)).length,
      ...describe(found),
    })),
    not_ranked_total: unranked.length,
    not_ranked: unranked
      .slice(0, limit)
      .map((found) => ({ reason: reason(found.row), ...describe(found) })),
    ninetieth_percentile: NINETIETH,
    data_url: `${SITE}${surgeryFile(surgery.kind, surgery.slug)}`,
    source: await source(read, surgery.sources, surgery),
  };
}

export async function explainUrgency(
  read: Reader,
  input: { category: string },
): Promise<UrgencyAnswer> {
  const needle = fold(input.category)
    .replace(/^(category|cat)\s*/u, '')
    .replace(/\s+/gu, '-');
  const category = CATEGORIES.find(
    (item) =>
      String(item.number) === needle ||
      item.word === needle.replace('semiurgent', 'semi-urgent').replace('nonurgent', 'non-urgent'),
  );
  if (category === undefined) {
    throw new ToolProblem(
      'That is not an urgency category. Use 1, 2 or 3, or urgent, semi-urgent or non-urgent.',
      CATEGORIES.map(({ number, word }) => ({ category: number, name: word })),
    );
  }
  const surgery = await need<Surgery>(read, surgeryFile('urgency', category.slug));
  return {
    category: category.number,
    name: category.word,
    source_name: surgery.name,
    recommended_within: category.within,
    meaning: category.meaning,
    who_decides:
      'Your treating specialist assigns the category after assessing you. The recommended time is a target. This is not clinical advice.',
    hospitals_listed: surgery.hospitals.length,
    page_url: `${SITE}/urgency/category-${String(category.number)}/`,
    data_url: `${SITE}${surgeryFile('urgency', category.slug)}`,
    source: await source(read, surgery.sources, surgery),
  };
}
