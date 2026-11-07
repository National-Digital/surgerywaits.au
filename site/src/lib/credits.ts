import { readDist } from './dist';

export interface Credit {
  slug: string;
  version: string;
  release: string | null;
  as_at: string | null;
  licence: string;
  attribution: string;
  citation: string;
  title: string;
  publisher: { name: string; url: string };
  dataset_url: string;
  url: string;
}

export class CreditError extends Error {}

// The cast is safe because readDist has just proved the document against its schema.
export function readCredits(): Credit[] {
  return (readDist('credits.json') as { sources: Credit[] }).sources;
}

// A source with no credit fails the build, so a page cannot cite what it does not credit.
export function creditsFor(sources: readonly string[], credits: readonly Credit[]): Credit[] {
  return sources.map((slug) => {
    const credit = credits.find((c) => c.slug === slug);
    if (credit === undefined) {
      throw new CreditError(`no credit for source ${slug} in credits.json`);
    }
    return credit;
  });
}

const LICENCE_URLS: Record<string, string> = {
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-3.0-AU': 'https://creativecommons.org/licenses/by/3.0/au/',
};

export function licenceUrl(licence: string): string {
  const url = LICENCE_URLS[licence];
  if (url === undefined) {
    throw new RangeError(`unknown licence: ${licence}`);
  }
  return url;
}

// The publishers of the credited datasets, each named once.
export const publisherList = (credits: readonly Credit[]): string =>
  [...new Set(credits.map((c) => c.publisher.name))].join(', ');
