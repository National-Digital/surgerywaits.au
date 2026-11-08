import { describe, expect, it } from 'vitest';

import { CATALOG_MEDIA_TYPE } from '../../../worker/headers';
import { surfaceBodyProblem } from './surfaces';

const entry = {
  identifier: 'urn:air:example:a:b',
  url: 'https://example.test/a',
  type: 'text/plain',
  representativeQueries: ['q'],
};
const body = (entries: unknown[]): string =>
  JSON.stringify({ specVersion: '1.0', host: {}, entries });
const problem = (entries: unknown[]): string | undefined =>
  surfaceBodyProblem('/.well-known/ard.json', body(entries));

describe('the catalog body check', () => {
  it('uses the catalog media type and accepts a whole entry', () => {
    expect(CATALOG_MEDIA_TYPE).toBe('application/ai-catalog+json');
    expect(problem([entry])).toBeUndefined();
  });

  it('rejects an entry missing a string identifier, url or type, or with no queries', () => {
    for (const field of ['identifier', 'url', 'type'] as const) {
      expect(problem([{ ...entry, [field]: 1 }]), field).toContain(field);
    }
    expect(problem([{ ...entry, representativeQueries: [] }])).toContain('representativeQueries');
    expect(problem([])).toBe('no entries');
  });
});
