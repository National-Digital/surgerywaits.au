import type { ArticleSection } from './content-schema';
import { formatNotPublished } from './format';
import {
  BORDER_COUNT,
  BORDER_RADIUS_KM,
  CHANGE_COUNT,
  LONGEST_COUNT,
  MIN_EXTREMES,
  MOVE_VOLUME_FLOOR,
} from './longest-page';
import rules from './pipeline-rules.json';
import { fillKnown } from './slots';
import {
  MAX_OUTSIDE,
  MAX_SPREAD_KM,
  MIN_PLACE_PAGES,
  MIN_RANKED,
  NEAR_RADIUS_KM,
  SMALL_STATE,
} from './surgery-page';

export const METHODOLOGY_PATH = '/methodology/';
export const DATA_PATH = '/data/';
export const ABOUT_PATH = '/about/';

type Reason = Parameters<typeof formatNotPublished>[0];

// The numbers and names the copy states, taken from the code that applies them.
export function methodologyFacts(): Record<string, string> {
  const facts: Record<string, string> = {
    neighbours: String(rules.neighbours),
    start_radius: String(rules.start_radius_km),
    max_period_age: String(rules.max_period_age_years),
    max_qld_lag: String(rules.max_qld_lag_days),
    hand_matched: String(rules.hand_matched_facilities),
    near_radius: String(NEAR_RADIUS_KM),
    max_outside: String(MAX_OUTSIDE),
    max_spread: String(MAX_SPREAD_KM),
    min_ranked: String(MIN_RANKED),
    min_place_pages: String(MIN_PLACE_PAGES),
    small_state: String(SMALL_STATE),
    min_extremes: String(MIN_EXTREMES),
    longest_count: String(LONGEST_COUNT),
    border_radius: String(BORDER_RADIUS_KM),
    border_count: String(BORDER_COUNT),
    change_count: String(CHANGE_COUNT),
    volume_floor: String(MOVE_VOLUME_FLOOR),
    median_name: rules.measures.median_wait,
    volume_name: rules.measures.volume,
    long_wait_name: rules.measures.long_wait,
    on_time_name: rules.measures.on_time,
    qld_withheld: formatNotPublished('not_given_by_queensland_health'),
  };
  for (const [marker, reason] of Object.entries(rules.withheld_codes)) {
    facts[`code_${reason}`] = marker;
    facts[`wording_${reason}`] = formatNotPublished(reason as Reason);
  }
  return facts;
}

export function fillSections(sections: ArticleSection[]): ArticleSection[] {
  const facts = methodologyFacts();
  const fill = (text: string): string => fillKnown(text, facts);
  return sections.map((s) => ({
    ...s,
    paragraphs: s.paragraphs.map(fill),
    ...(s.items === undefined ? {} : { items: s.items.map(fill) }),
  }));
}
