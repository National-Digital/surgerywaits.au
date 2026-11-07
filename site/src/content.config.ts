import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import {
  aboutSchema,
  areasSchema,
  healthServiceTemplateSchema,
  dataPageSchema,
  homeTemplateSchema,
  hospitalsIndexSchema,
  hospitalTemplateSchema,
  pairTemplateSchema,
  labelsSchema,
  longestTemplateSchema,
  methodologySchema,
  navigationSchema,
  pageSchema,
  siteSchema,
  stateTemplateSchema,
  surgeryNamesSchema,
  surgeryTemplateSchema,
  termsSchema,
  urgencyTemplateSchema,
} from './lib/content-schema';

const file = (name: string): ReturnType<typeof glob> => glob({ pattern: name, base: './content' });

export const collections = {
  site: defineCollection({ loader: file('site.yaml'), schema: siteSchema }),
  labels: defineCollection({ loader: file('labels.yaml'), schema: labelsSchema }),
  navigation: defineCollection({ loader: file('navigation.yaml'), schema: navigationSchema }),
  areas: defineCollection({ loader: file('areas.yaml'), schema: areasSchema }),
  'surgery-names': defineCollection({
    loader: file('surgery-names.yaml'),
    schema: surgeryNamesSchema,
  }),
  terms: defineCollection({ loader: file('terms.yaml'), schema: termsSchema }),
  templates: defineCollection({
    loader: glob({ pattern: ['hospital.yaml', 'hospitals.yaml'], base: './content/templates' }),
    schema: z.union([hospitalTemplateSchema, hospitalsIndexSchema]),
  }),
  surgery: defineCollection({
    loader: glob({ pattern: 'surgery.yaml', base: './content/templates' }),
    schema: surgeryTemplateSchema,
  }),
  pair: defineCollection({
    loader: glob({ pattern: 'pair.yaml', base: './content/templates' }),
    schema: pairTemplateSchema,
  }),
  state: defineCollection({
    loader: glob({ pattern: 'state.yaml', base: './content/templates' }),
    schema: stateTemplateSchema,
  }),
  urgency: defineCollection({
    loader: glob({ pattern: 'urgency.yaml', base: './content/templates' }),
    schema: urgencyTemplateSchema,
  }),
  'health-service': defineCollection({
    loader: glob({ pattern: 'health-service.yaml', base: './content/templates' }),
    schema: healthServiceTemplateSchema,
  }),
  home: defineCollection({
    loader: glob({ pattern: 'home.yaml', base: './content/templates' }),
    schema: homeTemplateSchema,
  }),
  longest: defineCollection({
    loader: glob({ pattern: 'longest.yaml', base: './content/templates' }),
    schema: longestTemplateSchema,
  }),
  pages: defineCollection({
    loader: glob({ pattern: 'not-found.yaml', base: './content/pages' }),
    schema: pageSchema,
  }),
  articles: defineCollection({
    loader: glob({
      pattern: ['methodology.yaml', 'data.yaml', 'about.yaml'],
      base: './content/pages',
    }),
    schema: z.union([methodologySchema, dataPageSchema, aboutSchema]),
  }),
};
