// Names the page and the DOM give the tool, and the element makers. It holds no copy.
export const SEL = {
  root: '[data-tool]',
  form: '.js-tool-form',
  fallback: '.js-tool-fallback',
  message: '.js-tool-message',
  results: '.js-tool-results',
  field: '.js-tool-field',
  input: '.js-combo-input',
  list: '.js-combo-list',
  item: 'li',
  label: 'label',
} as const;

export const LOAD = { idle: 'idle', loading: 'loading', done: 'done', failed: 'failed' } as const;
export type Load = (typeof LOAD)[keyof typeof LOAD];

// The only requests the tool makes, each for one of its own files.
export const FILES = {
  index: (): Promise<Response> => fetch('/tool/index.json'),
  places: (): Promise<Response> => fetch('/tool/places.json'),
  figures: (): Promise<Response> => fetch('/tool/figures.json'),
};

export const ATTR = {
  failed: 'data-failed',
} as const;
export const attr = (node: Element, name: string): string => node.getAttribute(name) ?? '';

// Words of the data file and of the platform that are not copy.
export const NAMES = {
  published: 'published',
  notReported: 'not_reported',
  notPublished: 'not_published',
  notReportedReason: 'not_reported_by_source',
  median: 'median_wait',
  volume: 'volume',
  normalForm: 'NFD',
} as const;

export const hospitalHref = (slug: string): string => `/hospital/${slug}/`;
export const pairHref = (slug: string, surgery: string): string =>
  `${hospitalHref(slug)}${surgery}/`;
export const headingId = (id: string): string => `${id}-heading`;

export function labelBy(node: HTMLElement, id: string): void {
  node.setAttribute('role', 'region');
  node.setAttribute('aria-labelledby', id);
}

export function asButton(node: HTMLButtonElement): void {
  node.type = 'button';
}

export const CLS = {
  option: 'c-combo__option',
  note: 'c-combo__note',
  results: 'c-results',
  result: 'c-result',
  name: 'c-result__name',
  distance: 'c-result__distance',
  facts: 'c-result__facts',
  note2: 'c-result__note',
  history: 'c-result__note c-result__history',
  withheld: 'c-result__note c-result__note--withheld',
  spark: 'c-spark',
  sparkLine: 'c-spark__line',
  sparkDot: 'c-spark__dot',
  button: 'c-button',
  print: 'c-button js-tool-print u-no-print',
  intro: 'c-results__intro',
  screenOnly: 'u-no-print',
  printOnly: 'c-print-only',
} as const;

export const EVENT = {
  click: 'click',
  input: 'input',
  keydown: 'keydown',
  mousedown: 'mousedown',
  blur: 'blur',
  focus: 'focus',
  submit: 'submit',
} as const;

export const KEY = {
  down: 'ArrowDown',
  up: 'ArrowUp',
  enter: 'Enter',
  escape: 'Escape',
} as const;

const SVG_NS = 'http://www.w3.org/2000/svg';
const JOIN = '; ';
export const joinPoints = (parts: string[]): string => parts.join(JOIN);

type Maker<E extends HTMLElement> = (className?: string, text?: string) => E;

const maker =
  <K extends keyof HTMLElementTagNameMap>(tag: K): Maker<HTMLElementTagNameMap[K]> =>
  (className, text) => {
    const node = document.createElement(tag);
    if (className !== undefined) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  };

export const make = {
  div: maker('div'),
  p: maker('p'),
  ul: maker('ul'),
  li: maker('li'),
  dl: maker('dl'),
  dt: maker('dt'),
  dd: maker('dd'),
  h2: maker('h2'),
  h3: maker('h3'),
  span: maker('span'),
  a: maker('a'),
  button: maker('button'),
};

// ARIA 1.2 combobox with a listbox popup, set by script because it means nothing without it.
export function enhanceInput(input: HTMLInputElement, listId: string): void {
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
}

export function enhanceList(list: HTMLElement, labelId: string): void {
  list.setAttribute('role', 'listbox');
  if (labelId !== '') {
    list.setAttribute('aria-labelledby', labelId);
  }
}

export function markSelected(node: HTMLElement, selected: boolean): void {
  node.setAttribute('aria-selected', String(selected));
}

export function markOption(node: HTMLElement, id: string, selected: boolean): void {
  node.setAttribute('role', 'option');
  node.id = id;
  markSelected(node, selected);
}

export function setOpen(input: HTMLInputElement, list: HTMLElement, open: boolean): void {
  input.setAttribute('aria-expanded', String(open));
  list.hidden = !open;
}

export function setActive(input: HTMLInputElement, id: string | null): void {
  if (id === null) {
    input.removeAttribute('aria-activedescendant');
  } else {
    input.setAttribute('aria-activedescendant', id);
  }
}

export interface SparkPoint {
  x: number;
  y: number | null;
}

// The runs of published points, which a gap of any size ends.
export function splitRuns(points: SparkPoint[]): SparkPoint[][] {
  const runs: SparkPoint[][] = [[]];
  for (const point of points) {
    if (point.y === null) {
      runs.push([]);
    } else {
      runs.at(-1)?.push(point);
    }
  }
  return runs.filter((run) => run.length > 0);
}

// A line over each run of published points and a dot on every one, in a 100 by 28 box.
export function sparkline(className: string, label: string, points: SparkPoint[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 100 28');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  for (const run of splitRuns(points).filter((r) => r.length > 1)) {
    const line = document.createElementNS(SVG_NS, 'path');
    line.setAttribute('class', CLS.sparkLine);
    line.setAttribute(
      'd',
      run.map((p, i) => `${i === 0 ? 'M' : 'L'}${String(p.x)} ${String(p.y ?? 0)}`).join(' '),
    );
    svg.append(line);
  }
  for (const point of points.filter((p) => p.y !== null)) {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('class', CLS.sparkDot);
    dot.setAttribute('cx', String(point.x));
    dot.setAttribute('cy', String(point.y ?? 0));
    dot.setAttribute('r', '2.5');
    svg.append(dot);
  }
  return svg;
}
