import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';

import { DIST_ENV, distDirectory, listSurgeries } from './dist';
import type { Surgery, SurgeryRow } from './dist';

const copies: string[] = [];

export function cleanUpCopies(): void {
  for (const copy of copies.splice(0)) {
    rmSync(copy, { recursive: true, force: true });
  }
}

// A copy of the fixture dist in which Bulli and Bourke report the surgeries Wollongong and Armidale do.
export function withNearbyPair(): string {
  const copy = mkdtempSync(join(tmpdir(), 'dist-'));
  copies.push(copy);
  cpSync(distDirectory(), copy, { recursive: true });
  const clone = (
    from: SurgeryRow,
    to: { code: string; slug: string; name: string },
  ): SurgeryRow => ({
    ...structuredClone(from),
    ...to,
  });
  for (const slug of listSurgeries('procedure')) {
    const file = join(copy, `surgeries/procedure/${slug}.json`);
    const surgery = JSON.parse(readFileSync(file, 'utf8')) as Surgery;
    const wollongong = surgery.hospitals.find((h) => h.code === 'H0047');
    const armidale = surgery.hospitals.find((h) => h.code === 'H0075');
    if (wollongong === undefined || armidale === undefined) {
      continue;
    }
    surgery.hospitals.push(
      clone(wollongong, { code: 'H0041', slug: 'bulli-hospital', name: 'Bulli Hospital' }),
      clone(armidale, {
        code: 'H0182',
        slug: 'bourke-multi-purpose-service',
        name: 'Bourke Multi Purpose Service',
      }),
    );
    writeFileSync(file, JSON.stringify(surgery));
  }
  vi.stubEnv(DIST_ENV, copy);
  return copy;
}

export type Spoil = 'closed' | 'stale' | 'withheld';

// The nearby pair, with one hospital's row for one procedure made closed, stale or withheld.
export function withSpoiledRow(slug: string, code: string, spoil: Spoil): void {
  const copy = withNearbyPair();
  const file = join(copy, `surgeries/procedure/${slug}.json`);
  const surgery = JSON.parse(readFileSync(file, 'utf8')) as Surgery;
  const row = surgery.hospitals.find((h) => h.code === code);
  if (row === undefined) {
    throw new RangeError(`${slug} has no row for ${code}`);
  }
  if (spoil === 'closed') {
    row.closed = true;
  }
  for (const measure of Object.values(row.measures)) {
    if (spoil === 'stale') {
      measure.figure.period = '2017–18';
    }
    if (spoil === 'withheld') {
      measure.figure = {
        state: 'not_published',
        reason: 'too_few_patients',
        period: measure.figure.period,
        release: measure.figure.release,
      };
      measure.rank = { status: 'unranked', why: 'not_published' };
    }
  }
  writeFileSync(file, JSON.stringify(surgery));
}
