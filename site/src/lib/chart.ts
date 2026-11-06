import { formatCount, formatPeriod, formatTrendPoint } from './format';
import { spanStamp } from './table';
import type { Span } from './table';
import type { Figure, NotPublishedReason, Role, TrendPoint } from './format';

export interface ChartSeries {
  name: string;
  release: string;
  periods: readonly string[];
  points: readonly TrendPoint[];
}

export type Shape = 'circle' | 'square' | 'triangle' | 'diamond';

interface Dot {
  x: string;
  y: string;
  d: string;
}

interface PlottedSeries {
  name: string;
  index: number;
  shape: Shape;
  modifier: string;
  dash: string | undefined;
  segments: string[];
  dots: Dot[];
  gaps: { x: string; y: string; d: string }[];
}

export interface ChartPlan {
  width: number;
  height: number;
  viewBox: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  ticks: { y: string; text: string }[];
  xLabels: { x: string; text: string }[];
  series: PlottedSeries[];
  periods: string[];
  stamp: string;
  span: Span;
  release: string;
}

const MAX_SERIES = 4;
// BEM modifiers cannot start with a digit, so the series are named in words.
const MODIFIERS = ['first', 'second', 'third', 'fourth'];
const DASHES = [undefined, '6 4', '2 3', '8 3 2 3'];

// The key swatch and the wait bar are drawn from these, so the templates hold no literal geometry.
export const SWATCH = { viewBox: '0 0 32 12', line: 'M0 6H32', x: 16, y: 6 } as const;
export const BAR = {
  viewBox: '0 0 100 8',
  ratio: 'none',
  width: 100,
  height: 8,
  origin: 0,
  marker: 1.5,
  // A positive value never draws narrower than this, so it cannot be mistaken for a published zero.
  min: 3,
} as const;

const SHAPES: readonly Shape[] = ['circle', 'square', 'triangle', 'diamond'];

const WIDTH = 360;
const HEIGHT = 224;
const LEFT = 44;
const RIGHT = 334;
const TOP = 46;
const BOTTOM = 190;
const MARK = 3.5;
const LABEL_SPACING = 58;

// Fixed precision keeps the output the same on every build; "-0.0" is folded into "0.0".
function fixed(n: number): string {
  const s = n.toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

export function markerPath(shape: Shape, x: number, y: number, r = MARK): string {
  const [a, b] = [fixed(x - r), fixed(x + r)];
  const [top, bottom] = [fixed(y - r), fixed(y + r)];
  const [cx, cy] = [fixed(x), fixed(y)];
  switch (shape) {
    case 'circle':
      return `M${a} ${cy}a${fixed(r)} ${fixed(r)} 0 1 0 ${fixed(2 * r)} 0a${fixed(r)} ${fixed(r)} 0 1 0 ${fixed(-2 * r)} 0z`;
    case 'square':
      return `M${a} ${top}H${b}V${bottom}H${a}z`;
    case 'triangle':
      return `M${cx} ${top}L${b} ${bottom}H${a}z`;
    case 'diamond':
      return `M${cx} ${top}L${b} ${cy}L${cx} ${bottom}L${a} ${cy}z`;
  }
}

export function crossPath(x: number, y: number, r = MARK): string {
  const [a, b] = [fixed(x - r), fixed(x + r)];
  const [top, bottom] = [fixed(y - r), fixed(y + r)];
  return `M${a} ${top}L${b} ${bottom}M${a} ${bottom}L${b} ${top}`;
}

const SHARES: readonly Role[] = ['long_wait', 'on_time'];
const TARGET_STEPS = 4;

// Shares are held as fractions and drawn as percentages; days and counts are drawn as they are.
const isShare = (role: Role): boolean => SHARES.includes(role);
const scaleOf = (role: Role): number => (isShare(role) ? 100 : 1);

interface Scale {
  max: number;
  step: number;
  places: number;
}

function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** exponent;
  const unit = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return unit * 10 ** exponent;
}

// The axis starts at zero; days and counts step in whole numbers, and a share gets the decimals its step needs.
function niceScale(role: Role, peak: number): Scale {
  const whole = !isShare(role);
  const raw = Math.max(0, peak) * scaleOf(role);
  const wanted = niceStep(Math.max(raw, 1e-9) / TARGET_STEPS);
  const step = whole ? Math.max(1, wanted) : wanted;
  const count = Math.max(1, Math.ceil(raw / step - 1e-9));
  const places = whole ? 0 : Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return { max: count * step, step, places };
}

function tickText(role: Role, scale: Scale, i: number): string {
  const n = Number((i * scale.step).toFixed(scale.places));
  if (!isShare(role)) {
    return formatCount(n);
  }
  return `${n.toFixed(scale.places)}%`;
}

// A share fills its own 0 to 100% track; days and counts fill a track that ends at a round number.
export function barWidth(role: Role, value: number, peak: number): string {
  const full = isShare(role) ? 100 : niceScale(role, peak).max;
  const width = (BAR.width * value * scaleOf(role)) / full;
  return (value > 0 ? Math.max(BAR.min, Math.min(BAR.width, width)) : 0).toFixed(1);
}

function pointFigure(role: Role, point: TrendPoint, period: string, release: string): Figure {
  // Formatting first, so a tag the contract does not know throws here.
  formatTrendPoint(role, point);
  if (point[1] !== null) {
    return { state: 'published', value: point[1], period, release };
  }
  const [state, reason = ''] = point[3].split(':');
  return state === 'not_reported'
    ? { state: 'not_reported', reason: 'not_reported_by_source', period, release }
    : { state: 'not_published', reason: reason as NotPublishedReason, period, release };
}

function chartSpan(periods: readonly string[], release: string): Span {
  const [first] = periods;
  const last = periods.at(-1);
  if (first === undefined || last === undefined) {
    throw new RangeError('a chart needs a reference period');
  }
  return { first, last, release };
}

function checkSeries(series: readonly ChartSeries[]): string {
  if (series.length < 1 || series.length > MAX_SERIES) {
    throw new RangeError(`a chart holds 1 to ${String(MAX_SERIES)} series`);
  }
  const release = series[0]?.release ?? '';
  for (const s of series) {
    if (s.release !== release) {
      throw new RangeError('every series in a chart must share one release');
    }
    if (s.periods.length !== s.points.length || s.points.length < 2) {
      throw new RangeError(`${s.name}: a series needs two or more points, one for each period`);
    }
    s.points.forEach((point, i) => {
      if (String(point[0]) !== s.periods[i]?.slice(0, 4)) {
        throw new RangeError(`${s.name}: point ${String(i)} does not match its period`);
      }
    });
  }
  return release;
}

export function planChart(role: Role, series: readonly ChartSeries[]): ChartPlan {
  const release = checkSeries(series);
  const periods = [...new Set(series.flatMap((s) => s.periods))].sort();
  const span = chartSpan(periods, release);
  const values = series.flatMap((s) => s.points.flatMap((p) => (p[1] === null ? [] : [p[1]])));
  const scale = niceScale(role, Math.max(0, ...values));
  const x = (i: number): number => LEFT + ((RIGHT - LEFT) * i) / Math.max(1, periods.length - 1);
  const y = (v: number): number => BOTTOM - ((BOTTOM - TOP) * v * scaleOf(role)) / scale.max;

  const plotted = series.map((s, index): PlottedSeries => {
    const shape = SHAPES[index] ?? 'circle';
    const segments: string[] = [];
    const dots: Dot[] = [];
    const gaps: PlottedSeries['gaps'] = [];
    let open: string[] = [];
    const close = (): void => {
      if (open.length > 1) {
        segments.push(open.join(''));
      }
      open = [];
    };
    s.periods.forEach((period, i) => {
      const point = s.points[i];
      const at = periods.indexOf(period);
      if (point === undefined) {
        return;
      }
      if (point[1] === null) {
        close();
        const gy = 8 + index * 9;
        gaps.push({ x: fixed(x(at)), y: fixed(gy), d: crossPath(x(at), gy) });
        return;
      }
      open.push(`${open.length === 0 ? 'M' : 'L'}${fixed(x(at))} ${fixed(y(point[1]))}`);
      dots.push({
        x: fixed(x(at)),
        y: fixed(y(point[1])),
        d: markerPath(shape, x(at), y(point[1])),
      });
    });
    close();
    return {
      name: s.name,
      index,
      shape,
      modifier: MODIFIERS[index] ?? '',
      dash: DASHES[index],
      segments,
      dots,
      gaps,
    };
  });

  const stride = Math.max(
    1,
    Math.ceil(LABEL_SPACING / ((RIGHT - LEFT) / Math.max(1, periods.length - 1))),
  );
  const xLabels = periods.flatMap((period, i) =>
    // The newest period is always labelled, and an older label that would crowd it is dropped.
    (periods.length - 1 - i) % stride === 0 ? [{ x: fixed(x(i)), text: formatPeriod(period) }] : [],
  );

  return {
    width: WIDTH,
    height: HEIGHT,
    viewBox: `0 0 ${String(WIDTH)} ${String(HEIGHT)}`,
    left: LEFT,
    right: RIGHT,
    top: TOP,
    bottom: BOTTOM,
    ticks: Array.from({ length: scale.max / scale.step + 1 }, (_, i) => ({
      y: fixed(BOTTOM - ((BOTTOM - TOP) * i * scale.step) / scale.max),
      text: tickText(role, scale, i),
    })),
    xLabels,
    series: plotted,
    periods,
    stamp: spanStamp(span),
    span,
    release,
  };
}

// One row for each period, one cell for each series; a period a series never reported reads "not reported".
export function tableFigures(
  role: Role,
  series: readonly ChartSeries[],
  periods: readonly string[],
  release: string,
): Figure[][] {
  return periods.map((period) =>
    series.map((s): Figure => {
      const i = s.periods.indexOf(period);
      const point = s.points[i];
      return point === undefined
        ? { state: 'not_reported', reason: 'not_reported_by_source', period, release }
        : pointFigure(role, point, period, release);
    }),
  );
}

export function publishedValue(figure: Figure): number | null {
  return figure.state === 'published' ? figure.value : null;
}
