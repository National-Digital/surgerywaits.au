import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { labelsSchema, pageSchema, siteSchema, termsSchema } from './lib/content-schema';

const file = (name: string): ReturnType<typeof glob> => glob({ pattern: name, base: './content' });

export const collections = {
  site: defineCollection({ loader: file('site.yaml'), schema: siteSchema }),
  labels: defineCollection({ loader: file('labels.yaml'), schema: labelsSchema }),
  terms: defineCollection({ loader: file('terms.yaml'), schema: termsSchema }),
  pages: defineCollection({
    loader: glob({ pattern: '*.yaml', base: './content/pages' }),
    schema: pageSchema,
  }),
};
