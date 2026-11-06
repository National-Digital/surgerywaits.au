import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import * as format from './format';
import type { Figure, NotPublishedReason, QueenslandFigure, TrendPoint } from './format';
import sample from './fixtures/dist-sample.json';

const stamp = { period: '2024–25', release: '2026-08-19' };

// Figures and points as the fixture build writes them for Cooktown Hospital and Mater Adult.
const published: Figure = { state: 'published', value: 13, ...stamp };
const notPublished: Figure = { state: 'not_published', reason: 'not_published_by_aihw', ...stamp };
const notReported: Figure = {
  state: 'not_reported',
  reason: 'not_reported_by_source',
  period: 'July to September 2025',
  release: '2025-10-28',
};
const firstPoint: TrendPoint = [2015, null, null, 'not_published:not_published_by_aihw'];
const secondPoint: TrendPoint = [2016, 35, null];
const thirdPoint: TrendPoint = [2017, 6, -29];

const qldPublished: QueenslandFigure = {
  state: 'published',
  value: 2713,
  period: 'July to September 2025',
  release: '2025-10-28',
};

const contract = JSON.parse(
  readFileSync(new URL('../../../contract/common.schema.json', import.meta.url), 'utf8'),
) as { $defs: { not_published_figure: { properties: { reason: { enum: string[] } } } } };
const contractReasons = contract.$defs.not_published_figure.properties.reason.enum;

describe('formatDays', () => {
  it.each([
    [0, '0 days'],
    [1, '1 day'],
    [13, '13 days'],
    [1234, '1,234 days'],
  ])('writes %d as %s', (n, text) => {
    expect(format.formatDays(n)).toBe(text);
  });

  it('refuses a number that is not finite', () => {
    expect(() => format.formatDays(Number.NaN)).toThrow(RangeError);
    expect(() => format.formatDays(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('formatCount and formatSurgeries', () => {
  it('groups thousands with a comma', () => {
    expect(format.formatCount(1234)).toBe('1,234');
    expect(format.formatCount(1234567)).toBe('1,234,567');
    expect(format.formatCount(999)).toBe('999');
    expect(format.formatCount(Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991');
  });

  it('keeps zero as a number', () => {
    expect(format.formatCount(0)).toBe('0');
    expect(format.formatSurgeries(0)).toBe('0 surgeries');
  });

  it('refuses a count above the safe integer range', () => {
    expect(() => format.formatCount(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() => format.formatCount(-(Number.MAX_SAFE_INTEGER + 2))).toThrow(RangeError);
  });

  it('never prints negative zero', () => {
    expect(format.formatCount(-0)).toBe('0');
  });

  it('uses the singular for one surgery', () => {
    expect(format.formatSurgeries(1)).toBe('1 surgery');
    expect(format.formatSurgeries(22)).toBe('22 surgeries');
  });
});

describe('formatKilometres', () => {
  it('uses the singular for one kilometre and groups thousands', () => {
    expect(format.formatKilometres(1)).toBe('1 kilometre');
    expect(format.formatKilometres(188)).toBe('188 kilometres');
    expect(format.formatKilometres(1250)).toBe('1,250 kilometres');
  });
});

describe('formatPercent', () => {
  it.each([
    [0.268, '26.8%'],
    [0.001, '0.1%'],
    [0.008, '0.8%'],
    [0, '0.0%'],
    [-0.0004, '0.0%'],
  ])('writes the long-wait fraction %d as %s', (fraction, text) => {
    expect(format.formatPercent('long_wait', fraction)).toBe(text);
  });

  it.each([
    [0.99, '99%'],
    [0.73, '73%'],
    [1, '100%'],
    [0, '0%'],
    [-0.004, '0%'],
  ])('writes the on-time fraction %d as %s', (fraction, text) => {
    expect(format.formatPercent('on_time', fraction)).toBe(text);
  });

  it('refuses a share that is not finite', () => {
    expect(() => format.formatPercent('on_time', Number.NaN)).toThrow(RangeError);
  });

  it('reads a Queensland percentage on the 0 to 100 scale', () => {
    expect(format.formatPercentPoints(88.3)).toBe('88.3%');
    expect(format.formatPercentPoints(100)).toBe('100.0%');
    expect(format.formatPercentPoints(0)).toBe('0.0%');
  });

  it('signs a Queensland change', () => {
    expect(format.formatPercentChange(20.3)).toBe('+20.3%');
    expect(format.formatPercentChange(-4.5)).toBe('-4.5%');
    expect(format.formatPercentChange(0)).toBe('0.0%');
  });
});

describe('formatRank', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [101, '101st'],
    [111, '111th'],
    [112, '112th'],
    [113, '113th'],
    [1002, '1,002nd'],
  ])('writes position %d as %s', (n, text) => {
    expect(format.formatOrdinal(n)).toBe(text);
  });

  it('says how many hospitals the rank is out of', () => {
    expect(format.formatRank(3, 40)).toBe('3rd of 40');
    expect(format.formatRank(1, 9)).toBe('1st of 9');
    expect(format.formatRank(12, 1200)).toBe('12th of 1,200');
  });

  it('refuses a rank outside its cohort', () => {
    expect(() => format.formatRank(0, 5)).toThrow(RangeError);
    expect(() => format.formatRank(6, 5)).toThrow(RangeError);
    expect(() => format.formatRank(1.5, 5)).toThrow(RangeError);
  });
});

describe('change values', () => {
  it('signs a change', () => {
    expect(format.formatSigned(8)).toBe('+8');
    expect(format.formatSigned(-29)).toBe('-29');
    expect(format.formatSigned(0)).toBe('0');
    expect(format.formatSigned(-0)).toBe('0');
    expect(format.formatSigned(1234)).toBe('+1,234');
  });

  it('adds the unit for each measure', () => {
    expect(format.formatChange('median_wait', -29)).toBe('-29 days');
    expect(format.formatChange('median_wait', 1)).toBe('+1 day');
    expect(format.formatChange('median_wait', -1)).toBe('-1 day');
    expect(format.formatChange('median_wait', 0)).toBe('0 days');
    expect(format.formatChange('volume', 7)).toBe('+7');
    expect(format.formatChange('on_time', 0.12)).toBe('+12 percentage points');
    expect(format.formatChange('on_time', 0.030000000000000027)).toBe('+3 percentage points');
    expect(format.formatChange('long_wait', -0.035)).toBe('-3.5 percentage points');
    expect(format.formatChange('long_wait', -0.0004)).toBe('0.0 percentage points');
    expect(format.formatChange('on_time', -0.004)).toBe('0 percentage points');
    expect(format.formatChange('long_wait', 0.0040000000000000036)).toBe('+0.4 percentage points');
  });

  it('describes a trend point', () => {
    expect(format.formatTrendChange('median_wait', thirdPoint)).toBe('-29 days');
    expect(format.formatTrendChange('median_wait', secondPoint)).toBe(
      'no earlier figure to compare',
    );
    expect(format.formatTrendChange('median_wait', firstPoint)).toBe(
      'not published: AIHW did not publish a figure',
    );
  });
});

describe('periods', () => {
  it('keeps the en dash', () => {
    expect(format.formatPeriod('2024–25')).toBe('2024–25');
  });

  it('repairs a hyphen to an en dash', () => {
    expect(format.formatPeriod('2024-25')).toBe('2024–25');
  });

  it('refuses text that is not a period', () => {
    expect(() => format.formatPeriod('2024')).toThrow(RangeError);
    expect(() => format.formatPeriod('')).toThrow(RangeError);
  });

  it('names a period from the year a trend point starts in', () => {
    expect(format.formatPeriodStartingIn(2024)).toBe('2024–25');
    expect(format.formatPeriodStartingIn(2015)).toBe('2015–16');
    expect(format.formatPeriodStartingIn(2099)).toBe('2099–00');
  });
});

describe('dates', () => {
  it.each([
    ['2026-08-19', '19 August 2026'],
    ['2026-11-02', '2 November 2026'],
    ['2024-02-29', '29 February 2024'],
    ['2025-12-31', '31 December 2025'],
    ['2026-01-01', '1 January 2026'],
  ])('writes %s as %s', (iso, text) => {
    expect(format.formatDate(iso)).toBe(text);
  });

  it('refuses text that is not an ISO date', () => {
    expect(() => format.formatDate('19 August 2026')).toThrow(RangeError);
    expect(() => format.formatDate('2026-08-19T00:00:00Z')).toThrow(RangeError);
    expect(() => format.formatDate('')).toThrow(RangeError);
  });

  it('refuses a day that does not exist', () => {
    expect(() => format.formatDate('2026-02-30')).toThrow(RangeError);
    expect(() => format.formatDate('2025-02-29')).toThrow(RangeError);
    expect(() => format.formatDate('2026-13-01')).toThrow(RangeError);
  });

  describe('in any time zone', () => {
    const original = process.env['TZ'];
    afterEach(() => {
      if (original === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = original;
      }
    });

    it.each(['Pacific/Kiritimati', 'Pacific/Pago_Pago'])('keeps the day in %s', (zone) => {
      process.env['TZ'] = zone;
      expect(format.formatDate('2026-08-19')).toBe('19 August 2026');
      expect(format.formatDate('2026-01-01')).toBe('1 January 2026');
      expect(format.formatDate('2025-12-31')).toBe('31 December 2025');
      expect(format.formatQuarter('2025-09-30')).toBe('July to September 2025');
    });
  });
});

describe('Queensland quarters', () => {
  it.each([
    ['2025-03-31', 'January to March 2025'],
    ['2025-06-30', 'April to June 2025'],
    ['2025-09-30', 'July to September 2025'],
    ['2025-12-31', 'October to December 2025'],
  ])('names the quarter ending %s', (end, text) => {
    expect(format.formatQuarter(end)).toBe(text);
  });

  it('refuses a date that does not end a quarter', () => {
    expect(() => format.formatQuarter('2025-09-29')).toThrow(RangeError);
    expect(() => format.formatQuarter('2025-10-31')).toThrow(RangeError);
  });
});

describe('not published reasons', () => {
  const words: Record<NotPublishedReason, string> = {
    too_few_patients: 'not published: too few patients',
    no_patients_reported: 'not published: no patients reported',
    not_published_by_aihw: 'not published: AIHW did not publish a figure',
    no_peer_group_comparison: 'not published: no peer group comparison',
    not_given_by_queensland_health: 'not published: Queensland Health gave no figure',
  };

  it.each(Object.entries(words) as [NotPublishedReason, string][])(
    'says %s in plain words',
    (reason, text) => {
      expect(format.formatNotPublished(reason)).toBe(text);
      expect(format.formatFigure('median_wait', { ...notPublished, reason })).toBe(text);
    },
  );

  it('covers every reason the contract allows and no other', () => {
    expect(Object.keys(words).sort()).toEqual([...contractReasons].sort());
  });

  it('refuses a reason it does not know', () => {
    expect(() => format.formatNotPublished('mystery' as NotPublishedReason)).toThrow(RangeError);
    expect(() => format.formatNotPublished('toString' as NotPublishedReason)).toThrow(RangeError);
  });

  it('reads a trend tag the same way as a figure', () => {
    for (const reason of contractReasons) {
      const point = [2015, null, null, `not_published:${reason}`] as const;
      expect(format.formatTrendPoint('volume', point)).toBe(
        format.formatNotPublished(reason as NotPublishedReason),
      );
    }
    expect(
      format.formatTrendPoint('volume', [2015, null, null, 'not_reported:not_reported_by_source']),
    ).toBe('not reported');
  });

  it('refuses a trend tag it does not know', () => {
    expect(() =>
      format.formatTrendPoint('volume', [2015, null, null, 'not_published:mystery']),
    ).toThrow(RangeError);
    expect(() =>
      format.formatTrendPoint('volume', [2015, null, null, 'not_published:toString']),
    ).toThrow(RangeError);
  });
});

describe('formatFigure', () => {
  it('writes a published figure for each measure', () => {
    expect(format.formatFigure('median_wait', published)).toBe('13 days');
    expect(format.formatFigure('volume', { ...published, value: 2713 })).toBe('2,713 surgeries');
    expect(format.formatFigure('on_time', { ...published, value: 1 })).toBe('100%');
    expect(format.formatFigure('long_wait', { ...published, value: 0.268 })).toBe('26.8%');
  });

  it('writes a published zero as 0, never as not published', () => {
    expect(format.formatFigure('median_wait', { ...published, value: 0 })).toBe('0 days');
    expect(format.formatFigure('volume', { ...published, value: 0 })).toBe('0 surgeries');
    expect(format.formatFigure('long_wait', { ...published, value: 0 })).toBe('0.0%');
    expect(format.formatFigure('on_time', { ...published, value: 0 })).toBe('0%');
    expect(format.formatTrendPoint('median_wait', [2020, 0, null])).toBe('0 days');
  });

  it('writes a not published figure with its reason', () => {
    expect(format.formatFigure('median_wait', notPublished)).toBe(
      'not published: AIHW did not publish a figure',
    );
  });

  it('writes a not reported figure as not reported', () => {
    expect(format.formatFigure('volume', notReported)).toBe('not reported');
  });

  it('says whether a figure carries a number', () => {
    expect(format.isPublished(published)).toBe(true);
    expect(format.isPublished(notPublished)).toBe(false);
    expect(format.isPublished(notReported)).toBe(false);
  });

  it('splits a published figure into its number and unit, and leaves words whole', () => {
    expect(format.formatFigureParts('median_wait', published)).toEqual({
      amount: '13',
      unit: 'days',
    });
    expect(format.formatFigureParts('on_time', { ...published, value: 0.97 })).toEqual({
      amount: '97%',
      unit: null,
    });
    expect(format.formatFigureParts('volume', notPublished)).toEqual({
      amount: 'not published: AIHW did not publish a figure',
      unit: null,
    });
  });

  it('writes the period and the release of any figure', () => {
    expect(format.formatStamp(published)).toBe('2024–25, released 19 August 2026');
    expect(format.formatStamp(notPublished)).toBe('2024–25, released 19 August 2026');
  });

  it('names a licence in words and rejects one it does not know', () => {
    expect(format.formatLicence('CC-BY-4.0')).toBe('CC BY 4.0');
    expect(format.formatLicence('CC-BY-3.0-AU')).toBe('CC BY 3.0 AU');
    expect(() => format.formatLicence('ARR')).toThrow(RangeError);
  });

  it('writes a trend point', () => {
    expect(format.formatTrendPoint('median_wait', secondPoint)).toBe('35 days');
  });
});

describe('every export', () => {
  const cases: Record<string, () => string> = {
    formatCount: () => format.formatCount(0),
    formatDays: () => format.formatDays(0),
    formatSurgeries: () => format.formatSurgeries(0),
    formatKilometres: () => format.formatKilometres(0),
    formatPercent: () => format.formatPercent('on_time', 0),
    formatQueenslandFigure: () => format.formatQueenslandFigure('treated', qldPublished),
    formatPercentPoints: () => format.formatPercentPoints(0),
    formatPercentChange: () => format.formatPercentChange(0),
    formatSigned: () => format.formatSigned(0),
    formatOrdinal: () => format.formatOrdinal(1),
    formatRank: () => format.formatRank(1, 1),
    formatPeriod: () => format.formatPeriod('2024–25'),
    formatPeriodStartingIn: () => format.formatPeriodStartingIn(2024),
    formatDate: () => format.formatDate('2026-08-19'),
    formatLicence: () => format.formatLicence('CC-BY-4.0'),
    formatQuarter: () => format.formatQuarter('2025-09-30'),
    formatNotPublished: () => format.formatNotPublished('too_few_patients'),
    formatMeasure: () => format.formatMeasure('volume', 0),
    formatChange: () => format.formatChange('volume', 0),
    formatFigure: () => format.formatFigure('volume', notReported),
    isPublished: () => String(format.isPublished(published)),
    formatFigureParts: () => format.formatFigureParts('volume', published).amount,
    formatStamp: () => format.formatStamp(published),
    formatTrendPoint: () =>
      format.formatTrendPoint('volume', [2015, null, null, 'not_reported:not_reported_by_source']),
    formatTrendChange: () => format.formatTrendChange('volume', [2015, 1, null]),
  };

  it('has a case for each function the module exports', () => {
    expect(Object.keys(cases).sort()).toEqual(Object.keys(format).sort());
  });

  it.each(Object.entries(cases))('%s never returns an empty string', (_name, call) => {
    expect(call().trim()).not.toBe('');
  });

  it('never returns an empty string for any figure state or measure', () => {
    const roles = ['median_wait', 'volume', 'long_wait', 'on_time'] as const;
    const figures: Figure[] = [
      published,
      { ...published, value: 0 },
      notReported,
      ...contractReasons.map((reason) => ({
        ...notPublished,
        reason: reason as NotPublishedReason,
      })),
    ];
    for (const role of roles) {
      for (const figure of figures) {
        expect(format.formatFigure(role, figure).trim()).not.toBe('');
      }
    }
  });
});

describe('Queensland figures', () => {
  const column = (name: keyof typeof sample.queenslandSample.total): QueenslandFigure =>
    sample.queenslandSample.total[name] as QueenslandFigure;

  it('formats a real quarter on the 0 to 100 scale', () => {
    const total = sample.queenslandSample.total;
    expect(format.formatQueenslandFigure('treated', column('treated'))).toBe(
      format.formatCount(total.treated.value),
    );
    expect(
      format.formatQueenslandFigure('percent_treated_in_time', column('percent_treated_in_time')),
    ).toBe(`${total.percent_treated_in_time.value.toFixed(1)}%`);
    expect(
      format.formatQueenslandFigure(
        'percent_change_treated_on_prior_year',
        column('percent_change_treated_on_prior_year'),
      ),
    ).toMatch(/^[+-]\d+\.\d%$/);
  });

  it('stamps a quarter given in words', () => {
    expect(format.formatStamp(column('treated'))).toBe(
      'July to September 2025, released 28 October 2025',
    );
    expect(format.formatQuarter(sample.queenslandSample.period_end)).toBe(column('treated').period);
  });

  it('writes the withheld and unreported states', () => {
    const base = { period: 'July to September 2025', release: '2025-10-28' };
    expect(
      format.formatQueenslandFigure('waiting', {
        state: 'not_published',
        reason: 'not_given_by_queensland_health',
        ...base,
      }),
    ).toBe('not published: Queensland Health gave no figure');
    expect(
      format.formatQueenslandFigure('percent_change_treated_on_prior_year', {
        state: 'not_reported',
        reason: 'not_reported_by_source',
        ...base,
      }),
    ).toBe('not reported');
  });

  it('keeps a published zero and a negative change', () => {
    const base = { period: 'July to September 2025', release: '2025-10-28' };
    expect(
      format.formatQueenslandFigure('long_waits', { state: 'published', value: 0, ...base }),
    ).toBe('0');
    expect(
      format.formatQueenslandFigure('percent_waiting_in_time', {
        state: 'published',
        value: 0,
        ...base,
      }),
    ).toBe('0.0%');
    expect(
      format.formatQueenslandFigure('percent_change_treated_on_prior_year', {
        state: 'published',
        value: -4.5,
        ...base,
      }),
    ).toBe('-4.5%');
  });

  it('refuses a stamp with no period', () => {
    expect(() => format.formatStamp({ ...qldPublished, period: ' ' })).toThrow(RangeError);
  });
});

describe('precision follows the source', () => {
  const places = (text: string): number => text.split('.')[1]?.replace(/\D.*$/, '').length ?? 0;
  const sourcePlaces = (n: number): number => places(String(Number(n.toFixed(10))));

  it.each(['long_wait', 'on_time'] as const)(
    'shows no more decimals than %s data has at most',
    (role) => {
      const most = Math.max(0, ...sample.values[role].map(sourcePlaces)) - 2;
      for (const fraction of sample.values[role]) {
        const text = format.formatPercent(role, fraction);
        expect(places(text)).toBeLessThanOrEqual(Math.max(0, most));
        expect(Number.parseFloat(text) / 100).toBeCloseTo(fraction, 9);
      }
    },
  );

  it.each(['long_wait', 'on_time'] as const)(
    'shows no more decimals than %s changes have',
    (role) => {
      const most = Math.max(0, ...sample.values[role].map(sourcePlaces)) - 2;
      for (const change of sample.changes[role]) {
        const text = format.formatChange(role, change);
        expect(places(text)).toBeLessThanOrEqual(Math.max(0, most));
        expect(Number.parseFloat(text) / 100).toBeCloseTo(change, 9);
      }
    },
  );

  it('writes whole numbers for days and counts', () => {
    for (const days of sample.values.median_wait) {
      expect(format.formatDays(days)).toMatch(/^[\d,]+ days?$/);
    }
    for (const count of sample.values.volume) {
      expect(format.formatSurgeries(count)).toMatch(/^[\d,]+ surgery|surgeries$/);
    }
  });

  it('keeps a Queensland percentage to the one decimal the source has', () => {
    for (const value of sample.queensland.percent_treated_in_time) {
      expect(places(format.formatPercentPoints(value))).toBe(1);
      expect(Number.parseFloat(format.formatPercentPoints(value))).toBeCloseTo(value, 9);
    }
  });
});
