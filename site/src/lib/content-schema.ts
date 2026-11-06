import { z } from 'astro/zod';

const text = z.string().trim().min(1);
const httpsUrl = z.url({ protocol: /^https$/ });

export const OPERATOR_SLOT = '{operator}';

export const siteSchema = z.strictObject({
  name: text,
  operator: z.strictObject({
    name: text,
    line: text.refine((line) => line.split(OPERATOR_SLOT).length === 2, {
      message: `the line must hold ${OPERATOR_SLOT} exactly once`,
    }),
    url: httpsUrl,
    contact_url: httpsUrl,
    contact_label: text,
  }),
});

// A key here is the only way to name a label, so a stray or missing key fails the build.
export const labelsSchema = z.strictObject({
  skip_link: text,
  title_home: text,
  title_not_found: text,
  go_home: text,
});

export const pageSchema = z.strictObject({
  heading: text,
  paragraphs: z.array(text).min(1),
});

export const termsSchema = z.strictObject({
  terms: z.array(z.strictObject({ preferred: text, replaces: z.array(text).min(1) })).min(1),
  quotes: z.array(z.strictObject({ page: text, term: text, reason: text })),
});

export type LabelKey = keyof z.infer<typeof labelsSchema>;
