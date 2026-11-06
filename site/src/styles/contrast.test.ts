import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, failingPairs, parseSchemes, usedPairs } from '../lib/contrast.ts';
import type { Pair } from '../lib/contrast.ts';

const tokenFile = new URL('./settings/colors.css', import.meta.url);
const schemes = parseSchemes(readFileSync(tokenFile, 'utf8'));

// Every foreground and background the redesign sets text on, by token name.
const TEXT_PAIRS: readonly Pair[] = [
  ['--ink', '--paper'],
  ['--ink', '--card'],
  ['--ink', '--card-2'],
  ['--ink-2', '--paper'],
  ['--ink-2', '--card'],
  ['--ink-2', '--card-2'],
  ['--muted', '--paper'],
  ['--muted', '--card'],
  ['--muted', '--card-2'],
  ['--accent', '--paper'],
  ['--accent', '--card'],
  ['--accent', '--accent-wash'],
  ['--accent-ink', '--accent'],
  ['--chip-note-ink', '--chip-note-wash'],
  ['--chip-good-ink', '--chip-good-wash'],
  ['--band-ink', '--band'],
  ['--band-ink-2', '--band'],
  ['--band-focus', '--band'],
  ['--foot-ink', '--foot'],
  ['--foot-ink-2', '--foot'],
  ['--foot-strong', '--foot'],
  ['--foot-safety', '--foot-panel'],
  ['--print-ink', '--print-paper'],
];

// Chart marks and control borders are not text, so WCAG 1.4.11 asks for 3:1.
const GRAPHIC_PAIRS: readonly Pair[] = [
  ['--control-border', '--paper'],
  ['--control-border', '--card'],
  ['--wait-fill', '--wait-track'],
  ['--s1', '--card'],
  ['--s2', '--card'],
  ['--s3', '--card'],
  ['--s4', '--card'],
];

const src = new URL('../', import.meta.url).pathname;
const styleText = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((f) => /\.(?:css|astro)$/.test(f))
  .map((f) => readFileSync(`${src}${f}`, 'utf8'))
  .map(
    (text) =>
      [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n') || text,
  )
  .join('\n');

const AAA = 7;
const GRAPHIC = 3;

describe('Design token contrast', () => {
  it('every text pair reaches 7:1 in the light scheme', () => {
    expect(failingPairs(schemes.light, TEXT_PAIRS, AAA)).toEqual([]);
  });

  it('every text pair reaches 7:1 in the dark scheme', () => {
    expect(failingPairs(schemes.dark, TEXT_PAIRS, AAA)).toEqual([]);
    expect(failingPairs(schemes.darkOverride, TEXT_PAIRS, AAA)).toEqual([]);
  });

  it('every graphic pair reaches 3:1 in both schemes', () => {
    expect(failingPairs(schemes.light, GRAPHIC_PAIRS, GRAPHIC)).toEqual([]);
    expect(failingPairs(schemes.dark, GRAPHIC_PAIRS, GRAPHIC)).toEqual([]);
  });

  it('covers every text and background pair the stylesheets use', () => {
    const covered = new Set([...TEXT_PAIRS, ...GRAPHIC_PAIRS].map(([a, b]) => `${a} ${b}`));
    const used = usedPairs(styleText);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(([a, b]) => !covered.has(`${a} ${b}`))).toEqual([]);
  });

  it('finds a pair a rule sets and ignores one-sided rules', () => {
    expect(
      usedPairs('.c-a { color: var(--ink); background: var(--card); } .c-b { color: var(--ink); }'),
    ).toEqual([['--ink', '--card']]);
  });

  it('rejects a colour format it cannot read', () => {
    expect(() => contrast('rgb(0 0 0)', '#fff')).toThrow(/unsupported colour "rgb\(0 0 0\)"/);
  });

  it('the system dark scheme and the data-theme dark override hold the same values', () => {
    expect(schemes.darkOverride).toEqual(schemes.dark);
  });

  it('computes the WCAG ratio for black on white and for the known lowest pairs', () => {
    expect(contrast('#000', '#fff')).toBeCloseTo(21, 5);
    expect(contrast('#49525e', '#f6f5f1')).toBeCloseTo(7.26, 2);
    expect(contrast('#0b5a0b', '#e4f3e4')).toBeCloseTo(7.35, 2);
  });

  it('fails a fixture that sets a pair below 7:1', () => {
    const fixture = parseSchemes(`
      :root { --ink: #777777; --paper: #ffffff; }
      :root:not([data-theme='light']) { --ink: #f1f3f6; }
      :root[data-theme='dark'] { --ink: #f1f3f6; }
    `);
    expect(failingPairs(fixture.light, [['--ink', '--paper']], AAA)).toEqual([
      '--ink on --paper: 4.48:1',
    ]);
    expect(failingPairs(fixture.light, [['--ink', '--missing']], AAA)).toEqual([
      '--ink on --missing: token missing',
    ]);
  });
});
