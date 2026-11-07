import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

interface Redirect {
  from: string;
  to: string;
}

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../data/${name}`, import.meta.url), 'utf8'));

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
  read('redirects.schema.json') as object,
);
const document = read('redirects.json');
const list = (document as { redirects: Redirect[] }).redirects;

describe('the redirects file', () => {
  it('matches its schema', () => {
    expect(validate(document), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects an entry the schema should refuse', () => {
    expect(validate({ redirects: [{ from: 'no-slash', to: '/a/' }] })).toBe(false);
    expect(validate({ redirects: [{ from: '/a/', to: '/b/', status: 302 }] })).toBe(false);
    expect(validate({ redirects: [{ from: '/a/' }] })).toBe(false);
    expect(validate({ redirects: [{ from: '/a/#x', to: '/b/' }] })).toBe(false);
    for (const to of ['https://x.test/b/', '//x.test/b/', '/b/#', '/b/#x#y', '/b#x', 'b/#x']) {
      expect(validate({ redirects: [{ from: '/a/', to }] }), to).toBe(false);
    }
  });

  it('accepts a fragment on a target only', () => {
    expect(validate({ redirects: [{ from: '/a/', to: '/b/#part-one' }] })).toBe(true);
  });

  it('lists each source once', () => {
    const sources = list.map((r) => r.from);
    expect(sources.filter((s, i) => sources.indexOf(s) !== i)).toEqual([]);
  });

  it('has no loop and no chain', () => {
    const sources = new Set(list.map((r) => r.from));
    expect(list.filter((r) => r.from === r.to)).toEqual([]);
    expect(list.filter((r) => sources.has(r.to.split('#')[0] ?? ''))).toEqual([]);
  });

  it('sends the earlier Tweed hospital page and each of its pairs to the current slug', () => {
    const tweed = list.filter((r) => r.from.startsWith('/hospital/tweed-valley-hospital/'));
    expect(tweed.length).toBeGreaterThan(1);
    expect(tweed.every((r) => r.to.startsWith('/hospital/the-tweed-hospital/'))).toBe(true);
    expect(tweed.some((r) => r.from === '/hospital/tweed-valley-hospital/')).toBe(true);
  });
});
