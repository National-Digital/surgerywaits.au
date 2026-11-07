import { getCollection, getEntry } from 'astro:content';
import { z } from 'astro/zod';
import {
  aboutSchema,
  areasSchema,
  healthServiceTemplateSchema,
  dataPageSchema,
  homeTemplateSchema,
  hospitalsIndexSchema,
  hospitalTemplateSchema,
  labelsSchema,
  longestTemplateSchema,
  methodologySchema,
  navigationSchema,
  pairTemplateSchema,
  pageSchema,
  siteSchema,
  stateTemplateSchema,
  surgeryNamesSchema,
  surgeryTemplateSchema,
  urgencyTemplateSchema,
} from './content-schema';
import type { LabelKey } from './content-schema';
import { formatRank } from './format';

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

const methodology = await single('articles', 'methodology', methodologySchema);
const dataPage = await single('articles', 'data', dataPageSchema);
const about = await single('articles', 'about', aboutSchema);

export const getMethodology = (): typeof methodology => methodology;
export const getDataPage = (): typeof dataPage => dataPage;
export const getAbout = (): typeof about => about;

const hospitalTemplate = await single('templates', 'hospital', hospitalTemplateSchema);
const hospitalsIndex = await single('templates', 'hospitals', hospitalsIndexSchema);

export function getHospitalsIndex(): typeof hospitalsIndex {
  return hospitalsIndex;
}

const surgeryTemplate = await single('surgery', 'surgery', surgeryTemplateSchema);
const pairTemplate = await single('pair', 'pair', pairTemplateSchema);
const areas = await single('areas', 'areas', areasSchema);
const surgeryNames = await single('surgery-names', 'surgery-names', surgeryNamesSchema);

const stateTemplate = await single('state', 'state', stateTemplateSchema);
const urgencyTemplate = await single('urgency', 'urgency', urgencyTemplateSchema);
const healthServiceTemplate = await single(
  'health-service',
  'health-service',
  healthServiceTemplateSchema,
);
const homeTemplate = await single('home', 'home', homeTemplateSchema);

const longestTemplate = await single('longest', 'longest', longestTemplateSchema);

export const getLongestTemplate = (): typeof longestTemplate => longestTemplate;
export const getStateTemplate = (): typeof stateTemplate => stateTemplate;
export const getHealthServiceTemplate = (): typeof healthServiceTemplate => healthServiceTemplate;
export const getHomeTemplate = (): typeof homeTemplate => homeTemplate;
export const getUrgencyTemplate = (): typeof urgencyTemplate => urgencyTemplate;
export const getSurgeryTemplate = (): typeof surgeryTemplate => surgeryTemplate;
export const getPairTemplate = (): typeof pairTemplate => pairTemplate;
export const getAreas = (): typeof areas => areas;
export const getSurgeryNames = (): typeof surgeryNames.names => surgeryNames.names;

export function getHospitalTemplate(): typeof hospitalTemplate {
  return hospitalTemplate;
}

export function getSite(): typeof site {
  return site;
}

export function getNavigation(): typeof navigation {
  return navigation;
}

export function getPage(id: 'not-found'): z.output<typeof pageSchema> {
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

// Every rank on the site is among all public hospitals in Australia, so every rank says so here.
export const nationalRank = (rank: { position: number; of: number }): string =>
  `${formatRank(rank.position, rank.of)} ${labels.rank_national}`;
