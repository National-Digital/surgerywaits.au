import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { assetsOver } from './mcp-fixture';
import {
  CATEGORIES,
  compareHospitals,
  explainUrgency,
  FIXED_PATHS,
  getWait,
  listProcedures,
  surgeryFile,
} from '../../../worker/mcp-tools';
import type { Reader } from '../../../worker/mcp-tools';

const dist = new URL('../../dist/', import.meta.url);
if (!existsSync(dist)) {
  throw new Error('site/dist is missing: run `npm run build` before BUILT_PAGES=1 npm test');
}
const asked: string[] = [];
const assets = assetsOver(new URL('data-api/', dist), asked);
const read: Reader = async (path) => {
  const response = await assets.fetch(`https://surgerywaits.au${path}`);
  return response.status === 404 ? null : response.json();
};
const built = (path: string): boolean => existsSync(new URL(`.${path}`, dist));

describe('the files the MCP tools read', () => {
  it('exist in the build: the fixed files, every surgery file and each urgency file', async () => {
    for (const path of FIXED_PATHS) {
      expect(built(path), path).toBe(true);
    }
    const { surgeries } = (await read('/data-api/surgeries.json')) as {
      surgeries: { kind: string; slug: string }[];
    };
    expect(surgeries.length).toBeGreaterThan(0);
    for (const { kind, slug } of surgeries) {
      expect(built(surgeryFile(kind, slug)), `${kind}/${slug}`).toBe(true);
    }
    for (const category of CATEGORIES) {
      expect(built(surgeryFile('urgency', category.slug)), category.slug).toBe(true);
    }
  });

  it('are the only files a run of every tool reads, and each of them exists', async () => {
    const { surgeries } = (await read('/data-api/surgeries.json')) as {
      surgeries: { kind: string; slug: string }[];
    };
    asked.length = 0;
    const first = surgeries.find((s) => s.kind !== 'urgency');
    expect(first).toBeDefined();
    const slug = first?.slug ?? '';
    await listProcedures(read, {});
    const national = await getWait(read, { procedure: slug });
    expect(national.scope).toBe('national');
    await getWait(read, { procedure: slug, state: 'NSW' });
    await compareHospitals(read, {
      procedure: slug,
      locality: 'Armidale',
      state: 'NSW',
      radius_km: 250,
    }).catch(() => undefined);
    for (const category of CATEGORIES) {
      await explainUrgency(read, { category: String(category.number) });
    }
    expect(asked.length).toBeGreaterThan(0);
    for (const url of asked) {
      const { pathname } = new URL(url);
      expect(pathname, url).toMatch(/^\/data-api\//u);
      expect(built(pathname), url).toBe(true);
    }
  });

  it('cite pages that exist in the build', async () => {
    const hospitals = (
      (await read('/data-api/hospitals.json')) as { hospitals: { slug: string }[] }
    ).hospitals;
    for (const { slug } of hospitals) {
      expect(built(`/hospital/${slug}/index.html`), slug).toBe(true);
    }
    for (const category of CATEGORIES) {
      const answer = await explainUrgency(read, { category: String(category.number) });
      expect(built(`${new URL(answer.page_url).pathname}index.html`), answer.page_url).toBe(true);
    }
  });
});
