import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CONTACTS, EXPIRES, POLICY, securityTxt } from './security-txt';

const DAY = 86_400_000;
const body = securityTxt();

describe('security.txt', () => {
  it('has the fields RFC 9116 requires, plus the language, canonical and policy fields', () => {
    expect(body).toMatch(/^Contact: \S+$/mu);
    expect(body).toMatch(/^Expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/mu);
    expect(body).toContain('Preferred-Languages: en\n');
    expect(body).toContain('Canonical: https://surgerywaits.au/.well-known/security.txt\n');
    expect(body).toContain(`Policy: ${POLICY}\n`);
    expect(body.endsWith('\n')).toBe(true);
  });

  it('names the contacts that SECURITY.md names', () => {
    const policy = readFileSync(new URL('../../../SECURITY.md', import.meta.url), 'utf8');
    for (const contact of CONTACTS) {
      expect(policy, contact).toContain(contact.replace('mailto:', ''));
    }
  });

  it('expires at most a year ahead, and not within 30 days: renew it before that', () => {
    const left = Date.parse(EXPIRES) - Date.now();
    expect(Number.isNaN(left)).toBe(false);
    expect(left).toBeGreaterThan(30 * DAY);
    expect(left).toBeLessThanOrEqual(366 * DAY);
  });
});
