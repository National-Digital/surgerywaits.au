import { z } from 'astro/zod';

const text = z.string().trim().min(1);
const httpsUrl = z.url({ protocol: /^https$/ });

export const OPERATOR_SLOT = '{operator}';

export const siteSchema = z.strictObject({
  name: text,
  // Canonical URLs are this origin plus a page path.
  url: httpsUrl,
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

const slots = (text_: string): string[] => [...new Set(text_.match(/\{[a-z_]+\}/g) ?? [])].sort();

// A sentence names exactly the slots its page fills, so a missing or unknown one fails the build.
const slotted = (...names: string[]): z.ZodString => {
  const want = names.map((n) => `{${n}}`).sort();
  return text.refine((value) => slots(value).join() === want.join(), {
    message: `the text must hold exactly the slots ${want.join(', ') || '(none)'}`,
  });
};

const states = z.strictObject({
  NSW: text,
  Vic: text,
  Qld: text,
  WA: text,
  SA: text,
  Tas: text,
  ACT: text,
  NT: text,
  OT: text,
});

export const hospitalTemplateSchema = z.strictObject({
  title: slotted('hospital', 'site'),
  title_closed: slotted('hospital', 'site'),
  description: slotted('hospital', 'state', 'period'),
  description_closed: slotted('hospital'),
  crumb_home: text,
  crumb_hospitals: text,
  lede: slotted('state'),
  lede_closed: slotted('state'),
  closed_heading: slotted(),
  closed_notice: slotted('hospital'),
  earlier_only_heading: slotted(),
  earlier_only_notice: slotted('hospital'),
  about_heading: slotted(),
  about_state: slotted(),
  about_network: slotted(),
  about_status: slotted(),
  about_names: slotted(),
  status_open: slotted(),
  status_closed: slotted(),
  network_none: slotted(),
  states,
  urgency: z.record(z.string().regex(/^[a-z0-9-]+$/), text),
  urgency_heading: slotted(),
  urgency_intro: slotted(),
  urgency_note: slotted(),
  tile_heading: slotted('measure', 'category'),
  procedures_heading: slotted(),
  procedures_intro: slotted(),
  procedures_caption: slotted('hospital'),
  procedures_row_heading: slotted(),
  specialties_heading: slotted(),
  specialties_intro: slotted(),
  specialties_caption: slotted('hospital'),
  specialties_row_heading: slotted(),
  trends_heading: slotted(),
  trends_intro: slotted(),
  chart_median_caption: slotted('hospital'),
  chart_median_name: slotted('hospital'),
  chart_on_time_caption: slotted('hospital'),
  chart_on_time_name: slotted('hospital'),
  qld_heading: slotted(),
  qld_intro: slotted('hospital'),
  qld_quarter: slotted('quarter'),
  nearby_heading: slotted(),
  nearby_heading_closed: slotted(),
  nearby_intro: slotted('hospital'),
  nearby_distance: slotted('distance'),
  nearby_none: slotted('hospital'),
  exclusion_heading: slotted(),
  exclusion: slotted(),
  ranking: slotted(),
});

export type LabelKey = keyof z.infer<typeof labelsSchema>;
