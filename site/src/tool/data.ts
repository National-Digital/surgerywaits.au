// The shape of /tool/data.json; contract/tool-data.schema.json describes the same file.
// A figure is its number, or -1 minus the place of its reason in `reasons` when it is withheld.
export type Value = number;
// The first year, then one value for each year after it, with null for a year with no point.
export type HistoryRow = readonly [start: number, ...values: (number | null)[]];
type Stamp = readonly [period: string, release: string];
export type HospitalRow = readonly [
  slug: string,
  name: string,
  state: string,
  latitude: number,
  longitude: number,
];
export type PlaceRow = readonly [name: string, state: string, latitude: number, longitude: number];
export type FigureRow = readonly [
  hospital: number,
  stamp: number,
  median: Value,
  volume: Value,
  rank: number | null,
  history: HistoryRow | null,
];

export interface Procedure {
  name: string;
  of: number;
  path: string;
  period: string;
  slug: string;
  terms: string[];
}

export interface ToolData {
  figures: Record<string, FigureRow[]>;
  hospitals: HospitalRow[];
  neighbours: number;
  places: PlaceRow[];
  procedures: Procedure[];
  reasons: string[];
  stamps: Stamp[];
  strings: Strings;
}

interface Strings {
  surgery_label: string;
  surgery_hint: string;
  place_label: string;
  place_hint: string;
  submit: string;
  count_one: string;
  count_many: string;
  count_none: string;
  found_as: string;
  need_surgery: string;
  need_place: string;
  results_heading: string;
  results_intro_one: string;
  results_intro_many: string;
  results_none: string;
  results_ready: string;
  distance: string;
  median: string;
  volume: string;
  period: string;
  history: string;
  history_none: string;
  history_label: string;
  history_point: string;
  rank: string;
  earlier_period: string;
  withheld_rank: string;
  closed_note: string;
  print: string;
  print_source: string;
  print_note: string;
}
