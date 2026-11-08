import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

// The scans behind the privacy gates; each takes source text so a fixture can fail it.
const BEACON_SCRIPT_HOST = 'https://static.cloudflareinsights.com';
const BEACON_REPORT_HOST = 'https://cloudflareinsights.com';
export const BEACON_SRC = `${BEACON_SCRIPT_HOST}/beacon.min.js`;

const STORAGE =
  /document\s*\.\s*cookie|document\s*\[\s*['"`]\s*cookie|cookieStore|localStorage|sessionStorage|indexedDB|\bcaches\s*[.[]|serviceWorker|(?<!delete\(\s*['"])set-cookie/giu;
const HISTORY =
  /\bhistory\s*\.\s*(?:pushState|replaceState|go|back|forward)\b|\b(?:pushState|replaceState)\b|\bhistory\s*\[|\[\s*['"`]history['"`]\s*\]|\blocation\s*(?:\.\s*(?:href|hash|search|pathname|assign|replace)\s*(?:=(?!=)|\()|=(?!=))|onhashchange|hashchange|popstate/gu;
const SENDERS = /sendBeacon|XMLHttpRequest|WebSocket|EventSource|new\s+Image\b/gu;
const FETCH = /\bfetch\b/gu;
const TOOL_FETCH = /^fetch\s*\(\s*(['"`])\/tool\/[\w-]+\.json\1\s*[,)]/u;

const found = (source: string, pattern: RegExp): string[] => [
  ...new Set([...source.matchAll(pattern)].map((m) => m[0].toLowerCase().replace(/\s+/gu, ''))),
];

export const storageUses = (source: string): string[] => found(source, STORAGE);
export const historyUses = (source: string): string[] => found(source, HISTORY);
export const sendingUses = (source: string): string[] => found(source, SENDERS);

// The first of a repeated directive wins in a browser, so a later one is a problem, not a policy.
function parsePolicy(policy: string): { directives: Map<string, string[]>; repeated: string[] } {
  const directives = new Map<string, string[]>();
  const repeated: string[] = [];
  for (const part of policy.split(';')) {
    const [name = '', ...values] = part.trim().split(/\s+/u);
    if (name === '') {
      continue;
    }
    const key = name.toLowerCase();
    if (directives.has(key)) {
      repeated.push(key);
    } else {
      directives.set(key, values);
    }
  }
  return { directives, repeated };
}

const isKeyword = (token: string): boolean => token.startsWith("'");

// Every source an unquoted token names, with its directive; a bare host or a scheme counts too.
export function policySources(policy: string): string[] {
  return [...parsePolicy(policy).directives]
    .flatMap(([name, values]) => values.filter((v) => !isKeyword(v)).map((v) => `${name} ${v}`))
    .sort();
}

const ALLOWED_SOURCES = [
  `connect-src ${BEACON_REPORT_HOST}`,
  `script-src ${BEACON_SCRIPT_HOST}`,
  'img-src data:',
];

// A policy passes when default-src is 'none' and every source is 'self', an image data: URL or the beacon's two hosts.
export const policyProblems = (policy: string): string[] => {
  const { directives, repeated } = parsePolicy(policy);
  const sources = policySources(policy);
  const defaults = directives.get('default-src');
  return [
    ...repeated.map((name) => `duplicate: ${name}`),
    ...(defaults?.join(' ') === "'none'"
      ? []
      : [`default-src: ${defaults?.join(' ') ?? 'missing'}`]),
    ...sources.filter((s) => !ALLOWED_SOURCES.includes(s)).map((s) => `extra: ${s}`),
    ...ALLOWED_SOURCES.filter((s) => !s.startsWith('img-src') && !sources.includes(s)).map(
      (s) => `missing: ${s}`,
    ),
    ...[...directives].flatMap(([name, values]) =>
      values
        .filter((v) => isKeyword(v) && v !== "'self'" && v !== "'none'")
        .map((v) => `keyword: ${name} ${v}`),
    ),
    ...(/\*|'unsafe-/u.test(policy) ? ['wildcard or unsafe'] : []),
  ];
};

// A fetch call in the tool, or in what it builds to, may name only one of the tool's own JSON files.
export const fetchProblems = (source: string): string[] =>
  [...source.matchAll(FETCH)]
    .filter((m) => !TOOL_FETCH.test(source.slice(m.index, m.index + 80)))
    .map((m) => `fetch: ${source.slice(m.index, m.index + 40).replace(/\s+/gu, ' ')}`);

// A parser reads script tags as a browser does, whatever their spacing or case.
function scripts(node: DefaultTreeAdapterTypes.ParentNode): DefaultTreeAdapterTypes.Element[] {
  return node.childNodes.flatMap((child) => [
    ...('tagName' in child && child.tagName === 'script' ? [child] : []),
    ...('childNodes' in child ? scripts(child) : []),
    ...('content' in child ? scripts(child.content) : []),
  ]);
}

// The one script the site may load from elsewhere: the Web Analytics beacon, with its token and nothing else.
function beaconToken(script: DefaultTreeAdapterTypes.Element): string | undefined {
  const names = script.attrs.map((a) => a.name).sort();
  const attr = (name: string): string => script.attrs.find((a) => a.name === name)?.value ?? '';
  const empty = script.childNodes.every((c) => !('value' in c) || c.value.trim() === '');
  if (names.join() !== 'data-cf-beacon,defer,src' || attr('src') !== BEACON_SRC || !empty) {
    return undefined;
  }
  try {
    const data = JSON.parse(attr('data-cf-beacon')) as Record<string, unknown>;
    const token = data['token'];
    return Object.keys(data).join() === 'token' && typeof token === 'string' ? token : undefined;
  } catch {
    return undefined;
  }
}

const beaconsOf = (html: string): (string | undefined)[] =>
  scripts(parse(html, { scriptingEnabled: false }))
    .filter((s) => s.attrs.some((a) => a.name === 'src' && a.value === BEACON_SRC))
    .map(beaconToken);

// A page must hold the beacon once, with the site's token.
export const beaconProblems = (html: string, token: string): string[] => {
  const found = beaconsOf(html);
  return found.length === 1 && found[0] === token
    ? []
    : [`beacon: ${found.length === 0 ? 'missing' : 'wrong or repeated'}`];
};

// What a built page loads from elsewhere, or runs inline, other than its one beacon.
export function pageProblems(html: string): string[] {
  const problems: string[] = [];
  // With scripting off, noscript content parses as elements too.
  for (const script of scripts(parse(html, { scriptingEnabled: false }))) {
    const src = script.attrs.find((a) => a.name === 'src')?.value.trim();
    const text = script.childNodes.map((c) => ('value' in c ? c.value : '')).join('');
    const type = script.attrs
      .find((a) => a.name === 'type')
      ?.value.trim()
      .toLowerCase();
    // A JSON-LD block is data the browser never runs, so only a src makes it a problem.
    if (type === 'application/ld+json' && src === undefined) {
      continue;
    }
    if (src === BEACON_SRC && beaconToken(script) !== undefined) {
      continue;
    }
    if (
      type === 'application/ld+json' ||
      (src === undefined ? text.trim() !== '' : !/^\/(?!\/)/.test(src))
    ) {
      problems.push(`script: ${src ?? 'inline'}`);
    }
  }
  return problems;
}
