import { getLongestTemplate } from './content';
import { formatCount, formatDays, formatFigure, formatKilometres } from './format';
import type { Figure } from './format';
import { fill } from './slots';
import { stateName } from './state-page';
import { surgeryPath } from './surgery-page';
import { competitionRanks } from './ranking-table';
import type { RankCell, RankingModel, RankRow } from './ranking-table';
import { BORDER_RADIUS_KM, longestStamp, MOVE_VOLUME_FLOOR, stateCode } from './longest-page';
import type { BorderPair, Entry, Extremes, Move } from './longest-page';
import { pairPath } from './pair-page';

const t = getLongestTemplate;

const pairLabel = (hospital: string, surgery: string): string =>
  fill(t().link_pair, { hospital, surgery });

const place = (e: Entry, template: string): RankCell => ({
  text: e.row.name,
  href: pairPath(e.row.slug, e.ref),
  label: pairLabel(e.row.name, e.ref.name),
  note: fill(template, {
    state: stateCode(e.row.state),
    median: formatFigure('median_wait', e.figure),
  }),
  figure: e.figure,
});

export function longestTable(entries: readonly Entry[]): RankingModel {
  const c = t();
  const ranks = competitionRanks(entries.map((e) => e.figure.value));
  return {
    columns: [
      c.column_rank,
      c.column_hospital,
      c.column_surgery,
      c.column_state,
      c.column_median,
      c.column_volume,
    ],
    rows: entries.map((e, i): RankRow => {
      const volume = e.row.measures.volume?.figure;
      return {
        key: `${e.row.slug}/${e.ref.slug}`,
        basis: [e.figure],
        cells: [
          { text: formatCount(ranks[i] ?? 0) },
          {
            text: e.row.name,
            href: pairPath(e.row.slug, e.ref),
            label: pairLabel(e.row.name, e.ref.name),
            heading: true,
          },
          { text: e.ref.name, href: surgeryPath(e.ref) },
          { text: stateCode(e.row.state) },
          { text: formatFigure('median_wait', e.figure), figure: e.figure },
          volume === undefined
            ? { text: '' }
            : { text: formatFigure('volume', volume), figure: volume },
        ],
      };
    }),
  };
}

export function extremesTable(all: readonly Extremes[]): RankingModel {
  const c = t();
  return {
    columns: [c.column_surgery, c.column_shortest, c.column_longest, c.column_hospitals],
    rows: all.map((e) => ({
      key: e.ref.slug,
      basis: [e.shortest.figure, e.longest.figure],
      cells: [
        { text: e.ref.name, href: surgeryPath(e.ref), heading: true },
        place(e.shortest, c.by_surgery_place),
        place(e.longest, c.by_surgery_place),
        { text: formatCount(e.reporting) },
      ],
    })),
  };
}

export function borderTable(pairs: readonly BorderPair[]): RankingModel {
  const c = t();
  const ranks = competitionRanks(pairs.map((p) => p.difference));
  return {
    columns: [
      c.column_rank,
      c.column_surgery,
      c.column_longer,
      c.column_across,
      c.column_distance,
      c.column_difference,
    ],
    rows: pairs.map((p, i) => ({
      key: `${p.from.row.slug}/${p.ref.slug}`,
      basis: [p.from.figure, p.to.figure],
      cells: [
        { text: formatCount(ranks[i] ?? 0) },
        { text: p.ref.name, href: surgeryPath(p.ref), heading: true },
        place(p.from, c.border_place),
        place(p.to, c.border_place),
        { text: formatKilometres(Math.round(p.km)) },
        { text: formatDays(p.difference) },
      ],
    })),
  };
}

export const radiusText = (): string => formatKilometres(BORDER_RADIUS_KM);

const changeText = (change: number): string =>
  fill(change > 0 ? t().change_up : t().change_down, { days: formatDays(Math.abs(change)) });

const stamped = (figure: Move['from']): RankCell => ({
  text: fill(t().change_figure, {
    median: formatFigure('median_wait', figure),
    period: figure.period,
  }),
  figure,
});

export function movesTable(moves: readonly Move[], hospitals: boolean): RankingModel {
  const c = t();
  const { raw } = longestStamp();
  const previous = moves[0]?.from.period ?? raw.period;
  return {
    columns: hospitals
      ? [
          c.column_hospital,
          c.column_surgery,
          c.column_state,
          c.column_was,
          c.column_now,
          c.column_change,
        ]
      : [c.column_surgery, c.column_state, c.column_was, c.column_now, c.column_change],
    rows: moves.map((m) => ({
      key: `${m.hospital?.slug ?? m.state}/${m.ref.slug}`,
      basis: [m.from, m.to],
      cells: [
        ...(m.hospital === undefined
          ? [
              {
                text: m.ref.name,
                href: m.href,
                label: fill(t().link_surgery_state, {
                  surgery: m.ref.name,
                  state: stateName(m.state),
                }),
                heading: true,
              },
            ]
          : [
              {
                text: m.hospital.name,
                href: m.href,
                label: pairLabel(m.hospital.name, m.ref.name),
                heading: true,
              },
              { text: m.ref.name, href: surgeryPath(m.ref) },
            ]),
        m.hospital === undefined
          ? { text: stateName(m.state), href: m.stateHref }
          : { text: stateCode(m.state) },
        stamped(m.from),
        stamped(m.to),
        { text: changeText(m.change) },
      ],
    })),
    span: { first: previous, last: raw.period, release: raw.release },
  };
}

export const floorText = (): string => formatCount(MOVE_VOLUME_FLOOR);

// The wait a figure states, so a page never names the measure itself.
export const waitText = (figure: Figure): string => formatFigure('median_wait', figure);

export interface ChangeSection {
  id: string;
  heading: string;
  caption: string;
  model: RankingModel;
  hospitals: boolean;
}

export function changeSections(
  state: { rises: readonly Move[]; falls: readonly Move[] },
  hospital: { rises: readonly Move[]; falls: readonly Move[] },
  period: string,
): { states: ChangeSection[]; hospitals: ChangeSection[] } {
  const c = t();
  const floor = floorText();
  return {
    states: [
      {
        id: 'state-rises',
        heading: c.state_rises_heading,
        caption: c.state_rises_caption,
        model: movesTable(state.rises, false),
        hospitals: false,
      },
      {
        id: 'state-falls',
        heading: c.state_falls_heading,
        caption: c.state_falls_caption,
        model: movesTable(state.falls, false),
        hospitals: false,
      },
    ],
    hospitals: [
      {
        id: 'hospital-rises',
        heading: c.hospital_rises_heading,
        caption: fill(c.hospital_rises_caption, { floor, period }),
        model: movesTable(hospital.rises, true),
        hospitals: true,
      },
      {
        id: 'hospital-falls',
        heading: c.hospital_falls_heading,
        caption: fill(c.hospital_falls_caption, { floor, period }),
        model: movesTable(hospital.falls, true),
        hospitals: true,
      },
    ],
  };
}
