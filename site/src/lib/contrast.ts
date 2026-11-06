export type Tokens = Record<string, string>;

export interface Schemes {
  light: Tokens;
  dark: Tokens;
  darkOverride: Tokens;
}

function declarations(body: string): Tokens {
  const tokens: Tokens = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[m[1] ?? ''] = (m[2] ?? '').trim();
  }
  return tokens;
}

// Reads the three token blocks the settings layer holds: light, the dark media query and the dark override.
export function parseSchemes(css: string): Schemes {
  const text = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector: string): Tokens => {
    const at = text.indexOf(`${selector} {`);
    if (at < 0) {
      throw new Error(`no ${selector} block`);
    }
    const open = text.indexOf('{', at);
    return declarations(text.slice(open + 1, text.indexOf('}', open)));
  };
  const light = block(':root');
  const media = block(":root:not([data-theme='light'])");
  const darkOverride = block(":root[data-theme='dark']");
  return { light, dark: { ...light, ...media }, darkOverride: { ...light, ...darkOverride } };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits;
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new Error(`unsupported colour "${hex}": the contrast check reads #rgb or #rrggbb only`);
  }
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16)));
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

export type Pair = readonly [foreground: string, background: string];

export function failingPairs(tokens: Tokens, pairs: readonly Pair[], floor: number): string[] {
  return pairs.flatMap(([fg, bg]) => {
    const [a, b] = [tokens[fg], tokens[bg]];
    if (a === undefined || b === undefined) {
      return [`${fg} on ${bg}: token missing`];
    }
    const ratio = contrast(a, b);
    return ratio < floor ? [`${fg} on ${bg}: ${ratio.toFixed(2)}:1`] : [];
  });
}

// Pairs a rule sets as var() tokens for its own text and background; one-sided rules inherit and are not seen.
export function usedPairs(css: string): Pair[] {
  const pairs = new Map<string, Pair>();
  for (const m of css.replaceAll(/\/\*[\s\S]*?\*\//g, '').matchAll(/\{([^{}]*)\}/g)) {
    const body = m[1] ?? '';
    const fg = /(?:^|[;\s])color\s*:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
    const bg = /(?:^|[;\s])background(?:-color)?\s*:\s*var\((--[\w-]+)\)/.exec(body)?.[1];
    if (fg !== undefined && bg !== undefined) {
      pairs.set(`${fg} ${bg}`, [fg, bg]);
    }
  }
  return [...pairs.values()];
}
