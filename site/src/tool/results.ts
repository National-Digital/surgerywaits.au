import {
  formatCount,
  formatFigure,
  formatKilometres,
  formatPeriod,
  formatPeriodStartingIn,
  formatRank,
  formatStamp,
  isPublished,
} from '../lib/format';
import type { Figure, NotPublishedReason } from '../lib/format';
import { fill } from '../lib/slots';
import type { FigureRow, HistoryRow, Procedure, ToolIndex, ToolProcedure, Value } from './data';
import {
  CLS,
  EVENT,
  NAMES,
  asButton,
  headingId,
  hospitalHref,
  joinPoints,
  labelBy,
  make,
  pairHref,
  sparkline,
} from './dom';
import type { SparkPoint } from './dom';

export interface Hit {
  row: FigureRow;
  km: number;
}

// A negative value is -1 minus the place of its reason in the file's list of reasons.
const figureOf = (value: Value, reasons: string[], period: string, release: string): Figure => {
  if (value >= 0) {
    return { state: NAMES.published, value, period, release };
  }
  const reason = reasons[-value - 1] ?? NAMES.notReportedReason;
  return reason === NAMES.notReportedReason
    ? { state: NAMES.notReported, reason, period, release }
    : { state: NAMES.notPublished, reason: reason as NotPublishedReason, period, release };
};

// One spot for each year of the run, with no height for a year with no published figure.
export function historySpots(run: HistoryRow): SparkPoint[] {
  const [, ...values] = run;
  const top = Math.max(...values.flatMap((v) => (v !== null && v >= 0 ? [v] : [])), 1);
  const span = Math.max(values.length - 1, 1);
  return values.map((value, i) => ({
    x: 4 + (i / span) * 92,
    y: value !== null && value >= 0 ? 26 - (value / top) * 24 : null,
  }));
}

function history(
  data: ToolIndex,
  row: FigureRow,
  name: string,
  release: string,
): SVGSVGElement | null {
  const run = row[5];
  if (run === null) {
    return null;
  }
  const t = data.strings;
  const [first, ...values] = run;
  const years = values.flatMap((value, i) => (value === null ? [] : [{ year: first + i, value }]));
  const figures = years.map(({ year, value }) =>
    figureOf(value, data.reasons, formatPeriodStartingIn(year), release),
  );
  const spots = historySpots(run);
  const label = fill(t.history_label, {
    hospital: name,
    points: joinPoints(
      figures.map((figure) =>
        fill(t.history_point, {
          period: figure.period,
          figure: formatFigure(NAMES.median, figure),
        }),
      ),
    ),
  });
  return sparkline(CLS.spark, label, spots);
}

function card(data: ToolIndex, file: ToolProcedure, hit: Hit, procedure: Procedure): HTMLElement {
  const t = data.strings;
  const [newest, of] = [procedure.period, procedure.of];
  const [index, stampAt, medianValue, volumeValue, rank] = hit.row;
  const [slug, name, state] = data.hospitals[index] ?? ['', '', ''];
  const [period, release] = file.stamps[stampAt] ?? ['', ''];
  const median = figureOf(medianValue, data.reasons, period, release);
  const volume = figureOf(volumeValue, data.reasons, period, release);
  const item = make.li(CLS.result);

  const heading = make.h3(CLS.name);
  const link = make.a(undefined, name);
  link.href = file.pairs.includes(index) ? pairHref(slug, procedure.surgery) : hospitalHref(slug);
  heading.append(link, make.span(undefined, ` ${state}`));
  item.append(
    heading,
    make.p(CLS.distance, fill(t.distance, { distance: formatKilometres(Math.round(hit.km)) })),
  );

  const facts = make.dl(CLS.facts);
  const add = (term: string, detail: string): void => {
    facts.append(make.dt(undefined, term), make.dd(undefined, detail));
  };
  add(t.median, formatFigure(NAMES.median, median));
  add(t.volume, formatFigure(NAMES.volume, volume));
  add(t.period, formatStamp(median));
  item.append(facts);

  if (rank !== null && period === newest) {
    item.append(
      make.p(CLS.note2, fill(t.rank, { rank: formatRank(rank, of), period: formatPeriod(period) })),
    );
  } else if (!isPublished(median)) {
    item.append(make.p(CLS.withheld, t.withheld_rank));
  } else if (period !== newest) {
    item.append(make.p(CLS.note2, t.earlier_period));
  }

  const chart = history(data, hit.row, name, release);
  item.append(make.p(CLS.history, t.history));
  item.append(chart ?? make.p(CLS.history, t.history_none));
  return item;
}

export function renderResults(
  mount: HTMLElement,
  data: ToolIndex,
  context: { surgery: string; place: string; procedure: Procedure; file: ToolProcedure },
  hits: Hit[],
): HTMLElement {
  const t = data.strings;
  const heading = make.h2(
    undefined,
    fill(t.results_heading, { surgery: context.surgery, place: context.place }),
  );
  heading.id = headingId(mount.id);
  labelBy(mount, heading.id);
  const first = hits[0];
  const own = first === undefined ? '' : (context.file.stamps[first.row[1]]?.[0] ?? '');
  const intro =
    hits.length === 0
      ? t.results_none
      : hits.length === 1
        ? fill(t.results_intro_one, {
            place: context.place,
            period: formatPeriod(own),
          })
        : fill(t.results_intro_many, {
            count: formatCount(hits.length),
            place: context.place,
          });
  const list = make.ul(CLS.results);
  list.append(...hits.map((hit) => card(data, context.file, hit, context.procedure)));
  const print = make.button(CLS.print, t.print);
  asButton(print);
  print.addEventListener(EVENT.click, () => {
    window.print();
  });
  mount.replaceChildren(heading, make.p(CLS.intro, intro), list);
  if (hits.length > 0) {
    mount.append(
      make.p(CLS.printOnly, t.print_source),
      make.p(CLS.screenOnly, t.print_note),
      print,
    );
  }
  mount.hidden = false;
  return heading;
}
