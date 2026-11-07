import { getSite } from './content';
import type { ArticleSection } from './content-schema';
import { readRules } from './dist';
import type { Rules } from './dist';
import { formatNotPublished } from './format';
import {
  BORDER_COUNT,
  BORDER_RADIUS_KM,
  CHANGE_COUNT,
  LONGEST_COUNT,
  MIN_EXTREMES,
  MOVE_VOLUME_FLOOR,
} from './longest-page';
import { fillKnown } from './slots';
import {
  MAX_OUTSIDE,
  MAX_SPREAD_KM,
  MIN_OPEN_HOSPITALS,
  MIN_PLACE_PAGES,
  MIN_RANKED,
  NEAR_RADIUS_KM,
  SMALL_STATE,
} from './surgery-page';

export const METHODOLOGY_PATH = '/methodology/';
export const DATA_PATH = '/data/';
export const ABOUT_PATH = '/about/';

type Reason = Parameters<typeof formatNotPublished>[0];

// The limits the site's own code applies.
export interface SiteLimits {
  nearRadiusKm: number;
  maxOutside: number;
  maxSpreadKm: number;
  minOpenHospitals: number;
  minRanked: number;
  minPlacePages: number;
  smallState: number;
  minExtremes: number;
  longestCount: number;
  borderRadiusKm: number;
  borderCount: number;
  changeCount: number;
  volumeFloor: number;
}

export const LIVE_LIMITS: SiteLimits = {
  nearRadiusKm: NEAR_RADIUS_KM,
  maxOutside: MAX_OUTSIDE,
  maxSpreadKm: MAX_SPREAD_KM,
  minOpenHospitals: MIN_OPEN_HOSPITALS,
  minRanked: MIN_RANKED,
  minPlacePages: MIN_PLACE_PAGES,
  smallState: SMALL_STATE,
  minExtremes: MIN_EXTREMES,
  longestCount: LONGEST_COUNT,
  borderRadiusKm: BORDER_RADIUS_KM,
  borderCount: BORDER_COUNT,
  changeCount: CHANGE_COUNT,
  volumeFloor: MOVE_VOLUME_FLOOR,
};

// The hospital codes are the ones that stand in a hospital figure's place, so the peer group code is not one.
const PEER_GROUP_REASON = 'no_peer_group_comparison';
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

// A count the copy names reads as a word below ten.
const countWord = (n: number): string => WORDS[n] ?? String(n);

// The numbers and names the methodology states, taken from the pipeline's rules and the site's limits.
export function methodologyFacts(
  rules: Rules = readRules(),
  limits: SiteLimits = LIVE_LIMITS,
): Record<string, string> {
  const facts: Record<string, string> = {
    neighbours: String(rules.neighbours),
    start_radius: String(rules.start_radius_km),
    max_period_age: String(rules.max_period_age_years),
    max_qld_lag: String(rules.max_qld_lag_days),
    hand_matched: String(rules.hand_matched_facilities),
    measure_count: countWord(Object.keys(rules.measures).length),
    hospital_code_count: countWord(
      Object.values(rules.withheld_codes).filter((reason) => reason !== PEER_GROUP_REASON).length,
    ),
    near_radius: String(limits.nearRadiusKm),
    max_outside: String(limits.maxOutside),
    max_spread: String(limits.maxSpreadKm),
    min_open: String(limits.minOpenHospitals),
    min_ranked: String(limits.minRanked),
    min_place_pages: String(limits.minPlacePages),
    small_state: String(limits.smallState),
    min_extremes: String(limits.minExtremes),
    longest_count: String(limits.longestCount),
    border_radius: String(limits.borderRadiusKm),
    border_count: String(limits.borderCount),
    change_count: String(limits.changeCount),
    volume_floor: String(limits.volumeFloor),
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

export const aboutFacts = (): Record<string, string> => ({ operator: getSite().operator.name });

export const dataFacts = (): Record<string, string> => ({});

export const fillText = (text: string, facts: Record<string, string>): string =>
  fillKnown(text, facts);

// Every text a section shows is filled, and a slot the page does not know throws.
export function fillSections(
  sections: ArticleSection[],
  facts: Record<string, string>,
): ArticleSection[] {
  const fill = (text: string): string => fillKnown(text, facts);
  return sections.map((s) => ({
    ...s,
    heading: fill(s.heading),
    paragraphs: s.paragraphs.map(fill),
    ...(s.items === undefined ? {} : { items: s.items.map(fill) }),
    ...(s.links === undefined
      ? {}
      : { links: s.links.map((l) => ({ ...l, label: fill(l.label) })) }),
  }));
}
