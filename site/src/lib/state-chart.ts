import type { Credit } from './credits';
import { creditsFor, readCredits } from './credits';
import { readSurgery } from './dist';
import { formatDate, formatFigure, formatLicence, formatPeriod, isPublished } from './format';
import type { Figure } from './format';
import { stateName } from './state-page';
import { surgeryRefs } from './surgery-page';

interface StateBar {
  name: string;
  figure: Figure;
}

export interface StateChart {
  title: string;
  period: string;
  release: string;
  bars: readonly StateBar[];
  credits: readonly Credit[];
}

const WIDTH = 720;
const LABEL_END = 224;
const TRACK_START = 232;
const TRACK_WIDTH = 398;
const VALUE_END = 708;
const FIRST_ROW = 92;
const ROW = 34;
const BAR_HEIGHT = 14;

const escape = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

// The full reason runs past the canvas edge at this size; the credit line names the publisher.
const chartReason = (figure: Figure): string =>
  figure.state === 'not_published' && figure.reason === 'not_published_by_aihw'
    ? 'Not published by the source'
    : capital(formatFigure('median_wait', figure));

const valueOf = (figure: Figure): number | null =>
  figure.state === 'published' ? figure.value : null;

// Published bars run shortest first, then the withheld ones in the order given, each with its reason.
function ordered(bars: readonly StateBar[]): StateBar[] {
  const published = bars
    .filter((bar) => isPublished(bar.figure))
    .sort(
      (a, b) => (valueOf(a.figure) ?? 0) - (valueOf(b.figure) ?? 0) || (a.name < b.name ? -1 : 1),
    );
  return [...published, ...bars.filter((bar) => !isPublished(bar.figure))];
}

export function stateChartSvg(chart: StateChart): string {
  for (const { name, figure } of chart.bars) {
    if (figure.period !== chart.period || figure.release !== chart.release) {
      throw new RangeError(`${name} does not share the chart's period and release`);
    }
  }
  const bars = ordered(chart.bars);
  const peak = Math.max(...bars.map((bar) => valueOf(bar.figure) ?? 0), 0);
  const credit = chart.credits
    .map((c) => `${c.publisher.name}, ${formatLicence(c.licence)}`)
    .filter((text, index, all) => all.indexOf(text) === index)
    .join('; ');
  const height = FIRST_ROW + bars.length * ROW + 34;
  const heading = `${chart.title}: median public hospital wait by state and territory, ${formatPeriod(chart.period)}`;
  const description = `Bar chart. ${bars
    .map((bar) => `${bar.name}: ${formatFigure('median_wait', bar.figure)}`)
    .join('; ')}.`;
  const rows = bars.map((bar, index) => {
    const y = FIRST_ROW + index * ROW;
    const text = y + 11;
    const label = `<text x="${String(LABEL_END)}" y="${String(text)}" text-anchor="end" font-size="13" fill="#14181d">${escape(bar.name)}</text>`;
    const value = valueOf(bar.figure);
    if (value === null) {
      const reason = chartReason(bar.figure);
      return `${label}<text x="${String(TRACK_START)}" y="${String(text)}" font-size="13" fill="#49525e">${escape(reason)}</text>`;
    }
    const filled = peak === 0 ? 0 : (value / peak) * TRACK_WIDTH;
    const marker =
      value === 0
        ? `<rect x="${String(TRACK_START)}" y="${String(y)}" width="3" height="${String(BAR_HEIGHT)}" fill="#14181d"/>`
        : '';
    return (
      `${label}<rect x="${String(TRACK_START)}" y="${String(y)}" width="${String(TRACK_WIDTH)}" height="${String(BAR_HEIGHT)}" rx="3" fill="#e6e9ee"/>` +
      `<rect x="${String(TRACK_START)}" y="${String(y)}" width="${filled.toFixed(1)}" height="${String(BAR_HEIGHT)}" rx="3" fill="#1844b9"/>${marker}` +
      `<text x="${String(VALUE_END)}" y="${String(text)}" text-anchor="end" font-size="13" font-weight="650" fill="#14181d">${escape(formatFigure('median_wait', bar.figure))}</text>`
    );
  });
  return `${[
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(height)}" viewBox="0 0 ${String(WIDTH)} ${String(height)}" role="img" aria-labelledby="chart-title chart-desc">`,
    `<title id="chart-title">${escape(heading)}</title>`,
    `<desc id="chart-desc">${escape(description)}</desc>`,
    `<rect width="${String(WIDTH)}" height="${String(height)}" fill="#ffffff"/>`,
    `<g font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">`,
    `<text x="16" y="32" font-size="19" font-weight="700" fill="#14181d">${escape(chart.title)}</text>`,
    `<text x="16" y="56" font-size="13" fill="#49525e">${escape(`Median public hospital wait by state or territory, ${formatPeriod(chart.period)}, released ${formatDate(chart.release)}`)}</text>`,
    ...rows,
    `<text x="16" y="${String(height - 12)}" font-size="12" fill="#49525e">${escape(`Source: ${credit}. surgerywaits.au`)}</text>`,
    '</g>',
    '</svg>',
  ].join('\n')}\n`;
}

// The schema lets a state leave out a measure, and the page promises every state a row.
export function stateBars(
  states: readonly { state: string; measures: { median_wait?: Figure } }[],
  period: string,
  release: string,
): StateBar[] {
  return states.map(({ state, measures }) => ({
    name: stateName(state),
    figure: measures.median_wait ?? {
      state: 'not_reported',
      reason: 'not_reported_by_source',
      period,
      release,
    },
  }));
}

export interface ChartFile {
  slug: string;
  svg: string;
}

// One chart for each procedure that has a state comparison, named by the address of its page.
export function stateChartFiles(): ChartFile[] {
  const credits = readCredits();
  return surgeryRefs()
    .filter((ref) => ref.kind === 'procedure')
    .flatMap((ref) => {
      const surgery = readSurgery('procedure', ref.slug);
      const bars = stateBars(surgery.benchmarks.states, surgery.period, surgery.release);
      if (bars.length === 0) {
        return [];
      }
      const svg = stateChartSvg({
        title: ref.name,
        period: surgery.period,
        release: surgery.release,
        bars,
        credits: creditsFor(surgery.sources, credits),
      });
      return [{ slug: ref.urlSlug, svg }];
    })
    .sort((a, b) => (a.slug < b.slug ? -1 : 1));
}
