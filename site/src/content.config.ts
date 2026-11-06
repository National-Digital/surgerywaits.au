import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import {
  areasSchema,
  hospitalTemplateSchema,
  labelsSchema,
  navigationSchema,
  pageSchema,
  siteSchema,
  surgeryNamesSchema,
  surgeryTemplateSchema,
  termsSchema,
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
    loader: glob({ pattern: 'hospital.yaml', base: './content/templates' }),
    schema: hospitalTemplateSchema,
  }),
  surgery: defineCollection({
    loader: glob({ pattern: 'surgery.yaml', base: './content/templates' }),
    schema: surgeryTemplateSchema,
  }),
  pages: defineCollection({
    loader: glob({ pattern: '*.yaml', base: './content/pages' }),
    schema: pageSchema,
  }),
};
