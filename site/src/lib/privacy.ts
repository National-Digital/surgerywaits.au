// The scans behind the privacy gates; each takes source text so a fixture can fail it.
const BEACON_SCRIPT_HOST = 'https://static.cloudflareinsights.com';
const BEACON_REPORT_HOST = 'https://cloudflareinsights.com';

const STORAGE =
  /document\s*\.\s*cookie|cookieStore|localStorage|sessionStorage|indexedDB|(?<!delete\(\s*['"])set-cookie/giu;
const HISTORY =
  /\bhistory\s*\.\s*(?:pushState|replaceState|go|back|forward)\b|\bhistory\s*\[|\blocation\s*(?:\.\s*(?:href|hash|search|pathname|assign|replace)\s*(?:=(?!=)|\()|=(?!=))|onhashchange|hashchange|popstate/gu;
const SENDERS = /sendBeacon|XMLHttpRequest|WebSocket|EventSource|new\s+Image\b/gu;

const found = (source: string, pattern: RegExp): string[] => [
  ...new Set([...source.matchAll(pattern)].map((m) => m[0].toLowerCase().replace(/\s+/gu, ''))),
];

export const storageUses = (source: string): string[] => found(source, STORAGE);
export const historyUses = (source: string): string[] => found(source, HISTORY);
export const sendingUses = (source: string): string[] => found(source, SENDERS);

// Every host a policy names, with the directive that allows it.
export function policyHosts(policy: string): string[] {
  return policy
    .split(';')
    .map((part) => part.trim().split(/\s+/u))
    .flatMap(([name = '', ...values]) =>
      values.filter((v) => /^https?:\/\//u.test(v)).map((v) => `${name} ${v}`),
    )
    .sort();
}

const ALLOWED_HOSTS = [`connect-src ${BEACON_REPORT_HOST}`, `script-src ${BEACON_SCRIPT_HOST}`];

// A policy passes when its only third-party hosts are the beacon's two, each in its own directive.
export const policyProblems = (policy: string): string[] => {
  const hosts = policyHosts(policy);
  return [
    ...hosts.filter((h) => !ALLOWED_HOSTS.includes(h)).map((h) => `extra: ${h}`),
    ...ALLOWED_HOSTS.filter((h) => !hosts.includes(h)).map((h) => `missing: ${h}`),
    ...(/\*|'unsafe-/u.test(policy) ? ['wildcard or unsafe'] : []),
  ];
};

// What a built page loads from elsewhere, or runs inline, or names as the beacon.
export function pageProblems(html: string): string[] {
  const problems: string[] = [];
  for (const tag of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
    const src = /\ssrc=["']?([^"'\s>]+)/iu.exec(tag[1] ?? '')?.[1];
    if (src === undefined ? (tag[2] ?? '').trim() !== '' : !src.startsWith('/')) {
      problems.push(`script: ${src ?? 'inline'}`);
    }
  }
  if (/cloudflareinsights|beacon\.min\.js|data-cf-beacon/iu.test(html)) {
    problems.push('beacon');
  }
  return problems;
}
