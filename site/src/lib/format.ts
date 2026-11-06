const LOCALE = 'en-AU';

export type Role = 'median_wait' | 'volume' | 'long_wait' | 'on_time';

export type NotPublishedReason =
  | 'too_few_patients'
  | 'no_patients_reported'
  | 'not_published_by_aihw'
  | 'no_peer_group_comparison'
  | 'not_given_by_queensland_health';

export interface PublishedFigure {
  state: 'published';
  value: number;
  period: string;
  release: string;
}

export interface NotPublishedFigure {
  state: 'not_published';
  reason: NotPublishedReason;
  period: string;
  release: string;
}

export interface NotReportedFigure {
  state: 'not_reported';
  reason: 'not_reported_by_source';
  period: string;
  release: string;
}

export type Figure = PublishedFigure | NotPublishedFigure | NotReportedFigure;

export type QueenslandColumn =
  | 'treated'
  | 'waiting'
  | 'long_waits'
  | 'long_waits_ready_for_surgery'
  | 'long_waits_not_ready_for_surgery'
  | 'percent_treated_in_time'
  | 'percent_waiting_in_time'
  | 'percent_waiting_in_time_ready_for_surgery'
  | 'percent_change_treated_on_prior_year';

// A Queensland figure is on a 0 to 100 scale and its period is the quarter in words.
export type QueenslandFigure =
  | { state: 'published'; value: number; period: string; release: string }
  | {
      state: 'not_published';
      reason: 'not_given_by_queensland_health';
      period: string;
      release: string;
    }
  | { state: 'not_reported'; reason: 'not_reported_by_source'; period: string; release: string };

export type TrendTag = `${'not_published' | 'not_reported'}:${string}`;

export type TrendPoint =
  | readonly [year: number, value: number, change: number | null]
  | readonly [year: number, value: null, change: null, tag: TrendTag];

const REASON_WORDS: Record<NotPublishedReason, string> = {
  too_few_patients: 'too few patients',
  no_patients_reported: 'no patients reported',
  not_published_by_aihw: 'AIHW did not publish a figure',
  no_peer_group_comparison: 'no peer group comparison',
  not_given_by_queensland_health: 'Queensland Health gave no figure',
};

const NOT_REPORTED = 'not reported';

const numbers = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 20 });
const signed = new Intl.NumberFormat(LOCALE, {
  maximumFractionDigits: 20,
  signDisplay: 'exceptZero',
});
const oneDecimal = decimals(1, 'negative');
const signedOneDecimal = decimals(1, 'exceptZero');
// Decimals follow the source: long-wait shares come to 0.1%, on-time shares to 1%.
const SHARE_DECIMALS = { long_wait: 1, on_time: 0 } as const;
type ShareRole = keyof typeof SHARE_DECIMALS;

function decimals(places: number, signDisplay: 'negative' | 'exceptZero'): Intl.NumberFormat {
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
    signDisplay,
  });
}

const shares = {
  long_wait: decimals(SHARE_DECIMALS.long_wait, 'negative'),
  on_time: decimals(SHARE_DECIMALS.on_time, 'negative'),
};
const shareChanges = {
  long_wait: decimals(SHARE_DECIMALS.long_wait, 'exceptZero'),
  on_time: decimals(SHARE_DECIMALS.on_time, 'exceptZero'),
};
const cardinal = new Intl.PluralRules(LOCALE);
const ordinal = new Intl.PluralRules(LOCALE, { type: 'ordinal' });
const dates = new Intl.DateTimeFormat(LOCALE, {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthNames = new Intl.DateTimeFormat(LOCALE, { month: 'long', timeZone: 'UTC' });

const ORDINAL_SUFFIX: Record<Intl.LDMLPluralRule, string> = {
  zero: 'th',
  one: 'st',
  two: 'nd',
  few: 'rd',
  many: 'th',
  other: 'th',
};

function finite(n: number): number {
  if (!Number.isFinite(n)) {
    throw new RangeError('a figure must be a finite number');
  }
  // Intl prints negative zero as "-0".
  return n === 0 ? 0 : n;
}

function whole(n: number): number {
  if (!Number.isInteger(n)) {
    throw new RangeError('expected a whole number');
  }
  return n;
}

function withUnit(n: number, one: string, other: string): string {
  return `${numbers.format(finite(n))} ${cardinal.select(n) === 'one' ? one : other}`;
}

export function formatCount(n: number): string {
  if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('a count above the safe integer range is not exact');
  }
  return numbers.format(finite(n));
}

export function formatDays(n: number): string {
  return withUnit(n, 'day', 'days');
}

export function formatKilometres(n: number): string {
  if (finite(n) < 1) {
    return 'less than 1 kilometre';
  }
  return withUnit(n, 'kilometre', 'kilometres');
}

export function formatHospitals(n: number): string {
  return withUnit(n, 'public hospital', 'public hospitals');
}

export function formatSurgeries(n: number): string {
  return withUnit(n, 'surgery', 'surgeries');
}

// The national tables hold shares as fractions of 1.
export function formatPercent(role: ShareRole, fraction: number): string {
  return `${shares[role].format(finite(fraction) * 100)}%`;
}

// Queensland Health's tables hold percentages on a 0 to 100 scale.
export function formatPercentPoints(points: number): string {
  return `${oneDecimal.format(finite(points))}%`;
}

export function formatPercentChange(points: number): string {
  return `${signedOneDecimal.format(finite(points))}%`;
}

export function formatSigned(n: number): string {
  return signed.format(finite(n));
}

export function formatOrdinal(n: number): string {
  const position = whole(n);
  if (position < 1) {
    throw new RangeError('an ordinal starts at 1');
  }
  return `${numbers.format(position)}${ORDINAL_SUFFIX[ordinal.select(position)]}`;
}

export function formatRank(position: number, of: number): string {
  if (whole(of) < 1 || whole(position) > of) {
    throw new RangeError('a rank sits inside its cohort');
  }
  return `${formatOrdinal(position)} of ${numbers.format(of)}`;
}

export function formatPeriod(period: string): string {
  const match = /^(\d{4})[–-](\d{2})$/.exec(period);
  if (!match) {
    throw new RangeError(`not a financial-year period: ${period}`);
  }
  return `${match[1] ?? ''}–${match[2] ?? ''}`;
}

export function formatPeriodStartingIn(year: number): string {
  const start = whole(year);
  const end = String((start + 1) % 100).padStart(2, '0');
  return `${String(start)}–${end}`;
}

function parseIso(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    throw new RangeError(`not an ISO date: ${iso}`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const back = new Date(time);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new RangeError(`not a real date: ${iso}`);
  }
  return time;
}

export function formatDate(iso: string): string {
  return dates.format(parseIso(iso));
}

// A Queensland quarter is named from its last day, such as 2025-09-30.
export function formatQuarter(periodEnd: string): string {
  const end = new Date(parseIso(periodEnd));
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (month % 3 !== 2 || end.getUTCDate() !== lastDay) {
    throw new RangeError(`not the last day of a quarter: ${periodEnd}`);
  }
  const first = monthNames.format(Date.UTC(year, month - 2, 1));
  return `${first} to ${monthNames.format(end)} ${String(year)}`;
}

export function formatNotPublished(reason: NotPublishedReason): string {
  if (!Object.hasOwn(REASON_WORDS, reason)) {
    throw new RangeError(`unknown reason: ${reason as string}`);
  }
  return `not published: ${REASON_WORDS[reason]}`;
}

export function formatMeasure(role: Role, value: number): string {
  switch (role) {
    case 'median_wait':
      return formatDays(value);
    case 'volume':
      return formatSurgeries(value);
    case 'long_wait':
    case 'on_time':
      return formatPercent(role, value);
  }
}

// A change in a share is a gap between two fractions, so it reads in percentage points.
export function formatChange(role: Role, change: number): string {
  switch (role) {
    case 'median_wait':
      return `${formatSigned(change)} ${Math.abs(change) === 1 ? 'day' : 'days'}`;
    case 'volume':
      return formatSigned(change);
    case 'long_wait':
    case 'on_time':
      return `${shareChanges[role].format(finite(change) * 100)} percentage points`;
  }
}

export function formatFigure(role: Role, figure: Figure): string {
  switch (figure.state) {
    case 'published':
      return formatMeasure(role, figure.value);
    case 'not_published':
      return formatNotPublished(figure.reason);
    case 'not_reported':
      return NOT_REPORTED;
  }
}

export function isPublished(figure: Figure | QueenslandFigure): boolean {
  return figure.state === 'published';
}

// The unit comes apart from the number so a page can set it smaller; a percentage keeps its sign.
export function formatFigureParts(
  role: Role,
  figure: Figure,
): { amount: string; unit: string | null } {
  const text = formatFigure(role, figure);
  const split = figure.state === 'published' ? /^(\S+) (\D.*)$/.exec(text) : null;
  return split ? { amount: split[1] ?? '', unit: split[2] ?? '' } : { amount: text, unit: null };
}

export function formatStamp(figure: Figure | QueenslandFigure): string {
  const quarter = figure.period.trim();
  if (quarter === '') {
    throw new RangeError('a figure needs a reference period');
  }
  const period = /^\d{4}[–-]\d{2}$/.test(quarter) ? formatPeriod(quarter) : quarter;
  return `${period}, released ${formatDate(figure.release)}`;
}

export function formatQueenslandFigure(column: QueenslandColumn, figure: QueenslandFigure): string {
  switch (figure.state) {
    case 'not_published':
      return formatNotPublished(figure.reason);
    case 'not_reported':
      return NOT_REPORTED;
    case 'published':
      if (column === 'percent_change_treated_on_prior_year') {
        return formatPercentChange(figure.value);
      }
      return column.startsWith('percent_')
        ? formatPercentPoints(figure.value)
        : formatCount(figure.value);
  }
}

function formatTag(tag: TrendTag): string {
  const [state, reason] = tag.split(':');
  if (state === 'not_reported' && reason === 'not_reported_by_source') {
    return NOT_REPORTED;
  }
  if (state === 'not_published' && reason !== undefined && Object.hasOwn(REASON_WORDS, reason)) {
    return formatNotPublished(reason as NotPublishedReason);
  }
  throw new RangeError(`unknown trend tag: ${tag}`);
}

export function formatTrendPoint(role: Role, point: TrendPoint): string {
  return point[1] === null ? formatTag(point[3]) : formatMeasure(role, point[1]);
}

export function formatTrendChange(role: Role, point: TrendPoint): string {
  if (point[1] === null) {
    return formatTag(point[3]);
  }
  return point[2] === null ? 'no earlier figure to compare' : formatChange(role, point[2]);
}

const LICENCES: Record<string, string> = {
  'CC-BY-4.0': 'CC BY 4.0',
  'CC-BY-3.0-AU': 'CC BY 3.0 AU',
};

export function formatLicence(licence: string): string {
  const name = LICENCES[licence];
  if (name === undefined) {
    throw new RangeError(`unknown licence: ${licence}`);
  }
  return name;
}
