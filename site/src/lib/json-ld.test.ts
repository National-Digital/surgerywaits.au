import { describe, expect, it } from 'vitest';

import type { Credit } from './credits';
import {
  organization,
  breadcrumbList,
  financialYear,
  fileDataset,
  hospital,
  serialise,
  sourceDataset,
  webPage,
} from './json-ld';

const site = {
  name: 'Test Site',
  url: 'https://example.test/',
  operator: {
    name: 'Test Operator',
    legal_name: 'Test Operator Legal',
    url: 'https://operator.test/',
    contact_url: 'https://operator.test/contact/',
  },
};
const credit: Credit = {
  slug: 'a',
  version: '2026-01-01',
  release: null,
  as_at: '2026-01-02',
  licence: 'CC-BY-4.0',
  attribution: 'A',
  citation: 'Cited A',
  title: 'Dataset A',
  publisher: { name: 'Publisher', url: 'https://publisher.test/' },
  dataset_url: 'https://data.test/d/a/v/2026-01-01/',
  url: 'https://data.test/d/a/v/2026-01-01/data.parquet',
};

describe('financialYear', () => {
  it('gives the ISO interval of a financial year, across a century', () => {
    expect(financialYear('2024–25')).toBe('2024-07-01/2025-06-30');
    expect(financialYear('2099–00')).toBe('2099-07-01/2100-06-30');
  });

  it('gives nothing for a period of another shape', () => {
    expect(financialYear('2025 Q1')).toBeUndefined();
  });
});

describe('json-ld', () => {
  it('names the publisher by its trading name and carries the registered name apart', () => {
    expect(organization(site)).toMatchObject({
      name: 'Test Operator',
      legalName: 'Test Operator Legal',
    });
  });

  it('ends a breadcrumb trail on the page itself', () => {
    const list = breadcrumbList(site, '/a/b/', [{ label: 'Home', href: '/' }, { label: 'Here' }]);
    expect(list['itemListElement']).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://example.test/' },
      { '@type': 'ListItem', position: 2, name: 'Here', item: 'https://example.test/a/b/' },
    ]);
  });

  it('gives a page no date and a medical page its own type', () => {
    const base = { path: '/p/', title: 'T' };
    expect(webPage(site, base)).not.toHaveProperty('dateModified');
    expect(webPage(site, base)).not.toHaveProperty('datePublished');
    expect(webPage(site, { ...base, medical: true })['@type']).toBe('MedicalWebPage');
  });

  it('dates a page dataset by when its data last changed and names each source inline', () => {
    const facts = {
      path: '/p/',
      name: 'N',
      description: 'D',
      file: '/data-api/x.json',
      period: '2024–25',
      release: '2026-01-02',
      credits: [credit],
    };
    const node = fileDataset(site, facts);
    expect(node).toHaveProperty('dateModified', '2026-01-02');
    expect(node).not.toHaveProperty('datePublished');
    expect(node['isBasedOn']).toEqual([
      { '@type': 'Dataset', '@id': credit.dataset_url, url: credit.dataset_url },
    ]);
    expect(node).not.toHaveProperty('citation');
  });

  it('describes a source dataset with its citation and gives the release of the publisher as its publication date', () => {
    const node = sourceDataset(credit, 'About A');
    expect(node).toHaveProperty('description', 'About A');
    expect(node).toHaveProperty('citation', credit.citation);
    expect(node).toHaveProperty('datePublished', '2026-01-02');
  });

  it('leaves out the position of a hospital with no coordinates', () => {
    const facts = { path: '/h/', name: 'H', region: 'R' };
    expect(hospital(site, { ...facts, latitude: null, longitude: null })).not.toHaveProperty('geo');
    expect(hospital(site, { ...facts, latitude: -1, longitude: 2 })).toHaveProperty('geo');
  });

  it('gives one licence as a string and several as a list', () => {
    const facts = {
      path: '/p/',
      name: 'N',
      description: 'D',
      file: '/data-api/x.json',
      period: '2024–25',
      release: '2026-01-02',
    };
    const other = { ...credit, licence: 'CC-BY-3.0-AU', dataset_url: 'https://data.test/b/' };
    expect(fileDataset(site, { ...facts, credits: [credit] })['license']).toBe(
      'https://creativecommons.org/licenses/by/4.0/',
    );
    expect(fileDataset(site, { ...facts, credits: [credit, other] })['license']).toEqual([
      'https://creativecommons.org/licenses/by/3.0/au/',
      'https://creativecommons.org/licenses/by/4.0/',
    ]);
  });

  it('escapes a value that would close the script element', () => {
    const text = serialise([{ '@type': 'Thing', name: '</script><b>' }]);
    expect(text).not.toContain('<');
    expect(JSON.parse(text)).toHaveProperty(['@graph', 0, 'name'], '</script><b>');
  });
});
