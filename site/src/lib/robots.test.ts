import { describe, expect, it } from 'vitest';

import { CONTENT_SIGNAL, NAMED_CRAWLERS, robotsTxt, SITE, SITEMAP_URL } from './robots';

const body = robotsTxt();

describe('robots.txt', () => {
  it('carries the content signal in the policy form', () => {
    expect(CONTENT_SIGNAL).toBe('Content-Signal: search=yes, ai-input=yes, ai-train=no');
    expect(body).toContain(`${CONTENT_SIGNAL}\n`);
  });

  it('names the nine crawlers, each with the signal and an Allow rule in its own group', () => {
    expect(NAMED_CRAWLERS).toHaveLength(9);
    for (const agent of ['*', ...NAMED_CRAWLERS]) {
      expect(body, agent).toContain(`User-agent: ${agent}\n${CONTENT_SIGNAL}\nAllow: /\n`);
    }
  });

  it('keeps the sitemap line', () => {
    expect(SITEMAP_URL).toBe('https://surgerywaits.au/sitemap.xml');
    expect(body.trimEnd().endsWith(`Sitemap: ${SITEMAP_URL}`)).toBe(true);
  });

  it('points agents to the guide and to llms.txt in a comment', () => {
    expect(body).toContain(`# For AI agents: ${SITE}/agents/ and ${SITE}/llms.txt\n`);
  });

  it('blocks nothing', () => {
    expect(body).not.toMatch(/^Disallow:/mu);
  });
});
