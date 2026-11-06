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
  nav_site: text,
  nav_about: text,
  nav_compare: text,
  back_to_top: text,
  home_link: text,
  nav_breadcrumb: text,
  passport_heading: text,
  passport_dataset: text,
  passport_publisher: text,
  passport_version: text,
  passport_released: text,
  passport_released_none: text,
  passport_licence: text,
  passport_citation: text,
  preview_safety: text,
  preview_breadcrumbs: text,
  preview_passport: text,
  preview_crumb_hospital: text,
  footer_safety_heading: text,
  footer_safety_full: text,
  footer_safety_compact: text,
  footer_emergency: text,
  footer_exclusion: text,
  title_home: text,
  title_not_found: text,
  go_home: text,
  earlier_period_note: text,
  rank_caption: text,
  change_caption: text,
  role_median_wait: text,
  role_volume: text,
  role_long_wait: text,
  role_on_time: text,
  qld_treated: text,
  qld_percent_treated_in_time: text,
  qld_percent_change_treated_on_prior_year: text,
  table_earlier_marker: text,
  table_scroll_hint: text,
  chart_period_heading: text,
  chart_table_summary: text,
  chart_key: text,
  chart_gap_key: text,
  title_primitives: text,
  preview_heading: text,
  preview_intro: text,
  preview_figures: text,
  preview_tiles: text,
  preview_withheld: text,
  preview_queensland: text,
  preview_table: text,
  preview_table_caption: text,
  preview_table_row_heading: text,
  preview_chart: text,
  preview_chart_gap: text,
  preview_chart_caption: text,
  preview_chart_name: text,
  preview_chart_this: text,
  preview_chart_national: text,
  preview_chart_table_caption: text,
  preview_wait_bars: text,
  preview_wait_bars_caption: text,
});

const sitePath = z
  .string()
  .regex(/^\/(?:[a-z0-9-]+\/)*$/, 'a path inside the site, ending in a slash');
const link = z.strictObject({ label: text, href: sitePath });

export const navigationSchema = z.strictObject({
  site: z.array(link).min(1),
  about: z.array(link).min(1),
  compare: link,
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
