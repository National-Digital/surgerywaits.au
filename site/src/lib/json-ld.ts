import { licenceUrl } from './credits';
import type { Credit } from './credits';

export type JsonLdNode = Record<string, unknown>;

const CONTEXT = 'https://schema.org';

interface Site {
  name: string;
  url: string;
  operator: { name: string; legal_name: string; url: string; contact_url: string };
}

// A fragment on the page's own address, so a node's id never collides with another page's.
const own = (origin: string, path: string, fragment: string): string =>
  `${new URL(path, origin).href}#${fragment}`;

// The slash after the host is part of the identifier, and the publisher's other sites spell it the same way.
const publisherId = (site: Site): string => new URL('#organization', site.operator.url).href;
const websiteId = (site: Site): string => new URL('#website', site.url).href;
const pageId = (site: Site, path: string): string => own(site.url, path, 'webpage');

export function organization(site: Site): JsonLdNode {
  return {
    '@type': 'Organization',
    '@id': publisherId(site),
    name: site.operator.name,
    legalName: site.operator.legal_name,
    url: site.operator.url,
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'enquiries',
      url: site.operator.contact_url,
    },
  };
}

export function website(site: Site): JsonLdNode {
  return {
    '@type': 'WebSite',
    '@id': websiteId(site),
    name: site.name,
    url: site.url,
    inLanguage: 'en-AU',
    publisher: { '@id': publisherId(site) },
  };
}

export interface PageFacts {
  path: string;
  title: string;
  description?: string | undefined;
  medical?: boolean | undefined;
  about?: string | undefined;
}

export function webPage(site: Site, page: PageFacts): JsonLdNode {
  return {
    '@type': page.medical === true ? 'MedicalWebPage' : 'WebPage',
    '@id': pageId(site, page.path),
    url: new URL(page.path, site.url).href,
    name: page.title,
    ...(page.description === undefined ? {} : { description: page.description }),
    inLanguage: 'en-AU',
    ...(page.about === undefined ? {} : { about: { '@id': page.about } }),
    isPartOf: { '@id': websiteId(site) },
    publisher: { '@id': publisherId(site) },
  };
}

export interface Crumb {
  label: string;
  href?: string | undefined;
}

// The last crumb is the current page and carries no link, so it takes the page's own address.
export function breadcrumbList(site: Site, path: string, crumbs: readonly Crumb[]): JsonLdNode {
  return {
    '@type': 'BreadcrumbList',
    '@id': own(site.url, path, 'breadcrumb'),
    itemListElement: crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.label,
      item: new URL(crumb.href ?? path, site.url).href,
    })),
  };
}

// "2024–25" covers 1 July 2024 to 30 June 2025. Any other shape has no interval to give.
export function financialYear(period: string): string | undefined {
  const match = /^(\d{4})[–-](\d{2})$/u.exec(period);
  if (match === null) {
    return undefined;
  }
  const start = Number(match[1]);
  const end = Math.floor(start / 100) * 100 + Number(match[2]);
  return `${String(start)}-07-01/${String(end < start ? end + 100 : end)}-06-30`;
}

const publisherOf = (credit: Credit): JsonLdNode => ({
  '@type': 'Organization',
  name: credit.publisher.name,
  url: credit.publisher.url,
});

const licences = (credits: readonly Credit[]): string | string[] => {
  const urls = [...new Set(credits.map((c) => licenceUrl(c.licence)))].sort();
  return urls.length === 1 ? (urls[0] ?? '') : urls;
};

// One node for each dataset the page credits, as publicdata.au describes it.
export function sourceDataset(credit: Credit, description: string): JsonLdNode {
  return {
    '@type': 'Dataset',
    '@id': credit.dataset_url,
    name: credit.title,
    description,
    url: credit.dataset_url,
    version: credit.version,
    creator: publisherOf(credit),
    license: licenceUrl(credit.licence),
    citation: credit.citation,
    isAccessibleForFree: true,
    ...(credit.as_at === null ? {} : { datePublished: credit.as_at }),
    distribution: {
      '@type': 'DataDownload',
      contentUrl: credit.url,
      encodingFormat: 'application/vnd.apache.parquet',
    },
  };
}

export interface FileDataset {
  path: string;
  name: string;
  description: string;
  // The page's data file, as a path on this site.
  file: string;
  period: string;
  // The release date of the data the file holds, which is when that data last changed.
  release: string;
  credits: readonly Credit[];
}

// A page's own data file as a dataset; its sources carry no title or citation, which only the data page may quote.
export function fileDataset(site: Site, facts: FileDataset): JsonLdNode {
  const coverage = financialYear(facts.period);
  return {
    '@type': 'Dataset',
    '@id': own(site.url, facts.path, 'dataset'),
    name: facts.name,
    description: facts.description,
    url: new URL(facts.path, site.url).href,
    inLanguage: 'en-AU',
    isAccessibleForFree: true,
    license: licences(facts.credits),
    isBasedOn: facts.credits.map((c) => ({
      '@type': 'Dataset',
      '@id': c.dataset_url,
      url: c.dataset_url,
    })),
    publisher: { '@id': publisherId(site) },
    ...(coverage === undefined ? {} : { temporalCoverage: coverage }),
    dateModified: facts.release,
    distribution: {
      '@type': 'DataDownload',
      contentUrl: new URL(facts.file, site.url).href,
      encodingFormat: 'application/json',
    },
  };
}

export interface HospitalFacts {
  path: string;
  name: string;
  region: string;
  latitude: number | null;
  longitude: number | null;
}

export const hospitalId = (site: Site, path: string): string => own(site.url, path, 'hospital');

export function hospital(site: Site, facts: HospitalFacts): JsonLdNode {
  return {
    '@type': 'Hospital',
    '@id': hospitalId(site, facts.path),
    name: facts.name,
    address: { '@type': 'PostalAddress', addressRegion: facts.region, addressCountry: 'AU' },
    ...(facts.latitude === null || facts.longitude === null
      ? {}
      : {
          geo: { '@type': 'GeoCoordinates', latitude: facts.latitude, longitude: facts.longitude },
        }),
  };
}

// One script's text. A "<" is escaped so no value can close the element.
export function serialise(nodes: readonly JsonLdNode[]): string {
  return JSON.stringify({ '@context': CONTEXT, '@graph': nodes }).replaceAll('<', '\\u003c');
}
