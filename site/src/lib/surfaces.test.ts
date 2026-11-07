import { describe, expect, it } from 'vitest';

import { redirectFor } from '../../../worker/redirects';
import { bodyProblem, isBuildAsset, SURFACES, surfaceOf } from './surfaces';

describe('the surfaces registry', () => {
  it('gives each surface its own id, a purpose and a media type', () => {
    expect(new Set(SURFACES.map((s) => s.id)).size).toBe(SURFACES.length);
    for (const surface of SURFACES) {
      expect(surface.purpose, surface.id).toMatch(/^[A-Z].*\.$/u);
      expect(surface.mediaType, surface.id).toMatch(/^[a-z]+\/[a-z+.-]+$/u);
    }
  });

  it('names each expected path once, under the surface whose pattern claims it and no other', () => {
    const seen = new Set<string>();
    for (const surface of SURFACES) {
      for (const path of surface.expected?.() ?? []) {
        expect(seen.has(path), path).toBe(false);
        seen.add(path);
        expect(path.startsWith('/'), path).toBe(true);
        expect(surfaceOf(path)?.id, path).toBe(surface.id);
        expect(SURFACES.filter((s) => s.pattern.test(path)).length, path).toBe(1);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('leaves each surface address clear of the Worker redirect table', () => {
    for (const surface of SURFACES) {
      for (const path of surface.expected?.() ?? []) {
        expect(redirectFor(path), path).toBeUndefined();
      }
    }
  });

  it('claims no page address', () => {
    for (const path of ['/', '/hospital/x/', '/data-api/', '/sitemap/', '/robots.txt/']) {
      expect(surfaceOf(path), path).toBeUndefined();
    }
  });

  it('lists the tool files from the routes that write them', () => {
    expect(SURFACES.find((s) => s.id === 'tool-files')?.expected?.()).toEqual([
      '/tool/figures.json',
      '/tool/index.json',
      '/tool/places.json',
    ]);
  });
});

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://surgerywaits.au/</loc></url>
</urlset>
`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>t</title><rect width="1"/></svg>\n';
const ROBOTS = 'User-agent: *\nAllow: /\n\nSitemap: https://surgerywaits.au/sitemap.xml\n';

describe('the body checks', () => {
  it('accept a sitemap, an SVG, a robots file and JSON that are whole', () => {
    expect(bodyProblem('application/xml', SITEMAP)).toBeUndefined();
    expect(bodyProblem('image/svg+xml', SVG)).toBeUndefined();
    expect(bodyProblem('text/plain', ROBOTS)).toBeUndefined();
    expect(bodyProblem('application/json', '{"a":1}')).toBeUndefined();
  });

  it('reject an unclosed comment and accept a comment that hides a tag', () => {
    expect(bodyProblem('image/svg+xml', SVG.replace('<svg', '<!-- open <svg'))).toBeDefined();
    expect(bodyProblem('image/svg+xml', SVG.replace('<svg', '<!-- <g> --><svg'))).toBeUndefined();
  });

  it('reject a truncated sitemap', () => {
    expect(bodyProblem('application/xml', SITEMAP.slice(0, -12))).toBeDefined();
    expect(bodyProblem('application/xml', SITEMAP.replace('</urlset>', ''))).toBeDefined();
  });

  it('reject a sitemap with the wrong root or two roots', () => {
    expect(bodyProblem('application/xml', '<html><body></body></html>')).toBeDefined();
    expect(bodyProblem('application/xml', `${SITEMAP}<urlset></urlset>`)).toBeDefined();
  });

  it('reject a truncated SVG and one whose tags cross', () => {
    expect(bodyProblem('image/svg+xml', SVG.slice(0, -10))).toBeDefined();
    expect(bodyProblem('image/svg+xml', SVG.replace('</title>', '</rect>'))).toBeDefined();
    expect(bodyProblem('image/svg+xml', '<div></div>')).toBeDefined();
  });

  it('reject junk, an empty body and a robots file without its lines', () => {
    expect(bodyProblem('text/plain', '<html>not robots</html>')).toBeDefined();
    expect(bodyProblem('text/plain', 'User-agent: *\nAllow: /\n')).toBeDefined();
    expect(
      bodyProblem('text/plain', 'Sitemap: https://surgerywaits.au/sitemap.xml\n'),
    ).toBeDefined();
    expect(bodyProblem('application/json', '{"a":')).toBeDefined();
    expect(bodyProblem('application/json', '  ')).toBeDefined();
  });
});

describe('the build asset exclusions', () => {
  it('cover pages, hashed scripts and styles, and fonts', () => {
    for (const path of [
      '/404.html',
      '/_astro/style.BSSxJyqw.css',
      '/_astro/ComparePage.astro_astro_type_script_index_0_lang.DsyWuHIt.js',
      '/fonts/newsreader.1bf9d9e7.woff2',
      '/fonts/OFL.txt',
    ]) {
      expect(isBuildAsset(path), path).toBe(true);
    }
  });

  it('do not hide a surface file placed under those folders', () => {
    for (const path of [
      '/_astro/data.json',
      '/_astro/chart.svg',
      '/_astro/style.css',
      '/_astro/nested/app.BSSxJyqw.js',
      '/fonts/list.json',
      '/fonts/robots.txt',
      '/robots.txt',
      '/sitemap.xml',
    ]) {
      expect(isBuildAsset(path), path).toBe(false);
    }
  });
});
