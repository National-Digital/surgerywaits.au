import { readContent } from './content-files';

// Stands in for astro:content under Vitest, where Astro's content layer is not populated.
// It serves the same YAML files, so content.ts still parses them through the real schemas.
const COLLECTIONS = new Map([
  ['site.yaml', 'site'],
  ['labels.yaml', 'labels'],
  ['navigation.yaml', 'navigation'],
  ['terms.yaml', 'terms'],
  ['areas.yaml', 'areas'],
  ['surgery-names.yaml', 'surgery-names'],
  ['procedure-synonyms.yaml', 'procedure-synonyms'],
]);

function entries(collection: string): { id: string; data: unknown }[] {
  return readContent().flatMap(({ path, data }) => {
    if (collection === 'templates' && path.startsWith('templates/')) {
      return [{ id: path.slice('templates/'.length).replace(/\.yaml$/, ''), data }];
    }
    if (collection === 'surgery' && path === 'templates/surgery.yaml') {
      return [{ id: 'surgery', data }];
    }
    if (collection === 'health-service' && path === 'templates/health-service.yaml') {
      return [{ id: 'health-service', data }];
    }
    if (collection === 'pair' && path === 'templates/pair.yaml') {
      return [{ id: 'pair', data }];
    }
    if (
      (collection === 'state' && path === 'templates/state.yaml') ||
      (collection === 'urgency' && path === 'templates/urgency.yaml') ||
      (collection === 'home' && path === 'templates/home.yaml') ||
      (collection === 'compare' && path === 'templates/compare.yaml') ||
      (collection === 'longest' && path === 'templates/longest.yaml')
    ) {
      return [{ id: collection, data }];
    }
    if (collection === 'guides' && path.startsWith('pages/guides/')) {
      return [{ id: path.slice('pages/guides/'.length).replace(/\.yaml$/, ''), data }];
    }
    const page =
      path.startsWith('pages/') && !path.startsWith('pages/guides/')
        ? path.slice('pages/'.length).replace(/\.yaml$/, '')
        : '';
    if (page !== '' && collection === (page === 'not-found' ? 'pages' : 'articles')) {
      return [{ id: page, data }];
    }
    return COLLECTIONS.get(path) === collection ? [{ id: collection, data }] : [];
  });
}

export function getEntry(collection: string, id: string): Promise<unknown> {
  return Promise.resolve(entries(collection).find((e) => e.id === id));
}

export function getCollection(collection: string): Promise<unknown[]> {
  return Promise.resolve(entries(collection));
}
