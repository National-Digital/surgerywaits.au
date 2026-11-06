import { getCollection, getEntry } from 'astro:content';
import { z } from 'astro/zod';
import { labelsSchema, navigationSchema, pageSchema, siteSchema } from './content-schema';
import type { LabelKey } from './content-schema';

// Parsing here types the entries, because astro:content falls back to any when its types clash.
const single = async <S extends z.ZodType>(
  collection: string,
  id: string,
  schema: S,
): Promise<z.output<S>> => {
  const entry: unknown = await getEntry(collection, id);
  const { data } = z.object({ data: z.unknown() }).parse(entry);
  return schema.parse(data);
};

// Loaded once at import, so a page reads the tables without awaiting.
const site = await single('site', 'site', siteSchema);
const labels = await single('labels', 'labels', labelsSchema);
const navigation = await single('navigation', 'navigation', navigationSchema);
const pages = new Map(
  z
    .array(z.object({ id: z.string(), data: pageSchema }))
    .parse((await getCollection('pages')) as unknown)
    .map(({ id, data }) => [id, data]),
);

export function getSite(): typeof site {
  return site;
}

export function getNavigation(): typeof navigation {
  return navigation;
}

export function getPage(id: 'home' | 'not-found'): z.output<typeof pageSchema> {
  const page = pages.get(id);
  if (page === undefined) {
    throw new Error(`content/pages/${id}.yaml is missing`);
  }
  return page;
}

// The key type comes from the schema, so a label that is not in the table fails the type check.
export function label(key: LabelKey): string {
  return labels[key];
}
