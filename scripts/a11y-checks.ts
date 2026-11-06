// House checks that axe cannot make: type size, line length, target size, link names, reflow and text spacing.
// A [data-conformance="aa"] region (dense tables) is held to WCAG 2.2 AA for target size and type floor.
import type { Page } from 'playwright';

export interface HouseConfig {
  proseFloorRem: number;
  anyFloorRem: number;
  rootAtWide: number;
  rootAtNarrow: number;
  wideWidth: number;
  maxCharsPerLine: number;
  targetAAA: number;
  targetAA: number;
  reflowWidth: number;
  generic: string[];
}

export type Mode =
  'all' | 'type' | 'reflow' | 'spacing' | 'menu-open' | 'menu-closed' | 'menu-nojs';

export interface Found {
  rule: string;
  target: string;
  detail: string;
}

export interface Exception {
  pages: string;
  rule: string;
  within: string;
  reason: string;
  reviewed: string;
}

export const HOUSE: HouseConfig = {
  proseFloorRem: 0.875, // text a person reads, outside dense data regions
  anyFloorRem: 0.75, // every other visible text, and everything inside a dense data region
  rootAtWide: 19, // px at a 2560px viewport: the type must grow with the screen
  rootAtNarrow: 16,
  wideWidth: 2560,
  maxCharsPerLine: 80, // WCAG 1.4.8
  targetAAA: 44, // WCAG 2.5.5
  targetAA: 24, // WCAG 2.5.8, inside dense data regions
  reflowWidth: 320, // WCAG 1.4.10
  generic: [
    'here',
    'click here',
    'read more',
    'more',
    'learn more',
    'link',
    'details',
    'download',
    'open',
    'view',
  ],
};

// Runs in the page, so it must stay self-contained; `mode` picks the checks.
/* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/restrict-template-expressions, @typescript-eslint/prefer-nullish-coalescing -- in-page DOM code, ported as written */
export function house(args: { cfg: HouseConfig; mode: Mode }): Found[] {
  const { cfg, mode } = args;
  const out: Found[] = [];
  const label = (el: Element | null): string => {
    if (!el?.tagName) {
      return 'null';
    }
    const id = el.id ? '#' + el.id : '';
    const cls = el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '';
    const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls}${text ? ` "${text}"` : ''}`;
  };
  const add = (rule: string, el: Element | null, detail: string): void => {
    out.push({ rule, target: label(el), detail });
  };
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const visible = (el: Element | null | undefined): boolean => {
    if (!el || el.closest('.vh, [hidden], script, style, noscript, template')) {
      return false;
    }
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const inAA = (el: Element): boolean => !!el.closest('[data-conformance="aa"]');
  const PROSE =
    'p, li, dd, dt, td, th, summary, label, figcaption, blockquote, h1, h2, h3, h4, h5, h6, a, button, input, select, textarea';
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="tab"], [role="link"], [tabindex="0"]';
  const toggle = [
    ...document.querySelectorAll<HTMLElement>('header button[aria-controls][aria-expanded]'),
  ].find(visible);
  const controlled = toggle
    ? document.getElementById(toggle.getAttribute('aria-controls') ?? '')
    : null;
  const scope: ParentNode =
    mode === 'menu-open' ? (controlled ?? document.createElement('div')) : document;

  if (mode === 'menu-open' && toggle) {
    if (toggle.getAttribute('aria-expanded') !== 'true') {
      add('menu-expanded', toggle, 'aria-expanded is not true after Enter');
    }
    if (!controlled || !visible(controlled)) {
      add('menu-shows', toggle, 'Enter does not show what the button controls');
    }
  }
  if (mode === 'menu-closed' && toggle) {
    if (toggle.getAttribute('aria-expanded') !== 'false') {
      add('menu-escape', toggle, 'Escape does not close the menu');
    } else if (controlled && visible(controlled)) {
      add('menu-escape-visible', controlled, 'the menu stays visible after Escape');
    }
    if (document.activeElement !== toggle) {
      add('menu-focus-return', toggle, 'focus does not return to the button after Escape');
    }
  }
  if (mode === 'menu-nojs') {
    const nav = document.querySelector('nav[aria-label="Site"]');
    const hidden = nav ? [...nav.querySelectorAll('a[href]')].filter((a) => !visible(a)) : [];
    if (nav && hidden.length) {
      add('menu-nojs', nav, `${hidden.length} site link(s) cannot be reached without script`);
    }
  }

  if (mode === 'all' || mode === 'type') {
    const want = mode === 'type' ? cfg.rootAtWide : cfg.rootAtNarrow;
    if (root < want) {
      add(
        'root-scale',
        document.documentElement,
        `root font-size ${root}px, expected at least ${want}px at ${innerWidth}px wide`,
      );
    }
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (!n.textContent?.trim()) {
        continue;
      }
      const el = n.parentElement;
      if (!el || seen.has(el) || !visible(el)) {
        continue;
      }
      seen.add(el);
      // SVG text is measured as painted: its user-unit size times the scale of the picture it sits in.
      const scale = el instanceof SVGGraphicsElement ? Math.abs(el.getScreenCTM()?.a ?? 1) : 1;
      const rem = (parseFloat(getComputedStyle(el).fontSize) * scale) / root;
      const floor = inAA(el)
        ? cfg.anyFloorRem
        : el.closest(PROSE)
          ? cfg.proseFloorRem
          : cfg.anyFloorRem;
      if (rem < floor - 0.001) {
        add(
          'type-floor',
          el,
          `${(rem * root).toFixed(1)}px is ${rem.toFixed(3)}rem, floor ${floor}rem`,
        );
      }
    }
    for (const el of document.querySelectorAll('p, li, dd, dt, blockquote')) {
      if (!visible(el) || inAA(el)) {
        continue;
      }
      if (
        [...el.children].some((c) =>
          /^(block|flex|grid|table|list-item)/.test(getComputedStyle(c).display),
        )
      ) {
        continue;
      }
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length < 120) {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set(
        [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top / 4)),
      );
      const lines = Math.max(1, tops.size);
      const cpl = Math.round(text.length / lines);
      if (cpl > cfg.maxCharsPerLine) {
        add(
          'measure',
          el,
          `${cpl} characters per line over ${lines} lines, maximum ${cfg.maxCharsPerLine}`,
        );
      }
    }
  }

  if (mode === 'all' || mode === 'menu-open') {
    const flows = /^(block|inline-block|list-item|table-cell)$/;
    for (const el of scope.querySelectorAll<HTMLElement>(INTERACTIVE)) {
      if (!visible(el) || el.closest('svg')) {
        continue;
      }
      let box: Element = el;
      if (el.matches('input[type="checkbox"], input[type="radio"]')) {
        box =
          el.closest('label') ??
          (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null) ??
          el;
      }
      const s = getComputedStyle(el);
      // WCAG 2.5.8 exempts a link inside a sentence.
      let wrapped: Element = el;
      let container = el.parentElement;
      while (container && getComputedStyle(container).display === 'inline') {
        wrapped = container;
        container = container.parentElement;
      }
      const inline =
        s.display === 'inline' &&
        !!container &&
        flows.test(getComputedStyle(container).display) &&
        [...container.childNodes].some(
          (c) =>
            c !== wrapped &&
            ((c.nodeType === 3 && c.textContent?.trim()) ||
              (c instanceof Element &&
                !c.matches(INTERACTIVE) &&
                !c.querySelector(INTERACTIVE) &&
                c.textContent.trim())),
        );
      if (inline) {
        continue;
      }
      const rects = [...box.getClientRects()];
      const w = Math.max(...rects.map((r) => r.width), 0);
      const h = Math.max(...rects.map((r) => r.height), 0);
      const min = inAA(el) ? cfg.targetAA : cfg.targetAAA;
      if (w + 0.5 < min || h + 0.5 < min) {
        add(
          'target-size',
          el,
          `${Math.round(w)}x${Math.round(h)}px, minimum ${min}px${inAA(el) ? ' (AA region)' : ''}`,
        );
      }
    }
    const generic = new Set(cfg.generic);
    for (const a of scope.querySelectorAll('a[href]')) {
      if (!visible(a)) {
        continue;
      }
      let name = a.getAttribute('aria-label') ?? '';
      const by = a.getAttribute('aria-labelledby');
      if (!name && by) {
        name = by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
      }
      if (!name) {
        name =
          a.textContent ||
          [...a.querySelectorAll('img[alt], svg[aria-label]')]
            .map((i) => i.getAttribute('alt') ?? i.getAttribute('aria-label'))
            .join(' ') ||
          a.getAttribute('title') ||
          '';
      }
      name = name.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!name) {
        add('link-name-missing', a, 'link has no accessible name');
      } else if (generic.has(name)) {
        add('link-name-generic', a, `"${name}" does not say where the link goes`);
      }
    }
    let focused = 0;
    for (const el of scope.querySelectorAll<HTMLElement>(INTERACTIVE)) {
      if (focused >= 80) {
        break;
      }
      if (!visible(el) || el.closest('svg') || el.closest('.xhost')) {
        continue;
      }
      focused++;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el) {
        continue;
      }
      const s = getComputedStyle(el);
      const ok =
        (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2) ||
        (s.boxShadow && s.boxShadow !== 'none');
      if (!ok) {
        add('focus-visible', el, `focused outline is ${s.outlineStyle} ${s.outlineWidth}`);
      }
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  if (mode === 'reflow') {
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      const wide = [...document.body.querySelectorAll('*')].filter(
        (el) =>
          visible(el) &&
          el.getBoundingClientRect().right > doc.clientWidth + 1 &&
          getComputedStyle(el).position !== 'fixed',
      );
      add(
        'reflow',
        wide[0] ?? doc,
        `page scrolls sideways at ${doc.clientWidth}px (${doc.scrollWidth}px wide); ${wide.length} elements overflow`,
      );
    }
  }

  if (mode === 'spacing') {
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      add('text-spacing-scroll', doc, 'page scrolls sideways with the text-spacing override');
    }
    for (const el of document.body.querySelectorAll('*')) {
      if (!visible(el) || inAA(el) || el.closest('svg, .xhost')) {
        continue;
      }
      const s = getComputedStyle(el);
      if (
        !/^(hidden|clip)$/.test(s.overflowX) &&
        !/^(hidden|clip)$/.test(s.overflowY) &&
        s.textOverflow !== 'ellipsis'
      ) {
        continue;
      }
      if (s.webkitLineClamp && s.webkitLineClamp !== 'none') {
        continue;
      }
      if (!el.textContent.trim()) {
        continue;
      }
      if (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2) {
        add(
          'text-spacing-cut',
          el,
          `text is cut off with the text-spacing override (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`,
        );
      }
    }
  }
  return out;
}
/* eslint-enable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/restrict-template-expressions, @typescript-eslint/prefer-nullish-coalescing -- end of in-page code */

// WCAG 1.4.12's override, injected before the "spacing" pass.
export const TEXT_SPACING =
  '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}';

const FREEZE = '*,*::before,*::after{caret-color:transparent!important;outline:none!important}';
const HIDE_TEXT =
  '*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}text,tspan{fill:transparent!important}';

interface Painted {
  target: string;
  ratio: number | null;
  need: number;
}
interface TargetInfo {
  target: string;
  missing: boolean;
  fg: string;
  alpha: number;
  large: boolean;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Measures painted contrast where axe cannot name one background (gradients, overlaps): 7:1, or 4.5:1 for large text.
export async function paintedContrast(page: Page, targets: string[]): Promise<Painted[]> {
  if (!targets.length) {
    return [];
  }
  const freeze = await page.addStyleTag({ content: FREEZE });
  // Both captures must see the same frame.
  await page.evaluate(() => {
    document.getAnimations().forEach((a) => {
      try {
        a.finish();
      } catch {
        a.pause();
      }
    });
  });
  const out: Painted[] = [];
  try {
    const info = await page.evaluate((ts): TargetInfo[] => {
      return ts.map((t) => {
        const el = document.querySelector(t);
        if (!el) {
          return { target: t, missing: true, fg: '', alpha: 1, large: false };
        }
        const s = getComputedStyle(el);
        let alpha = 1;
        for (let a: Element | null = el; a; a = a.parentElement) {
          alpha *= parseFloat(getComputedStyle(a).opacity);
        }
        const size = parseFloat(s.fontSize);
        const bold = parseInt(s.fontWeight, 10) >= 700;
        return {
          target: t,
          missing: false,
          fg: el instanceof SVGElement ? s.fill : s.color,
          alpha,
          large: size >= 24 || (bold && size >= 18.66),
        };
      });
    }, targets);
    for (const n of info) {
      if (n.missing) {
        continue;
      }
      const rect: Rect = await page.evaluate((t) => {
        const el = document.querySelector(t);
        if (!el) {
          return { x: 0, y: 0, width: 0, height: 0 };
        }
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.floor(r.left));
        const y = Math.max(0, Math.floor(r.top));
        return {
          x,
          y,
          width: Math.min(Math.ceil(r.right), innerWidth) - x,
          height: Math.min(Math.ceil(r.bottom), innerHeight) - y,
        };
      }, n.target);
      if (rect.width < 1 || rect.height < 1) {
        continue;
      }
      const shown = (await page.screenshot({ clip: rect })).toString('base64');
      const hide = await page.addStyleTag({ content: HIDE_TEXT });
      const bare = (await page.screenshot({ clip: rect })).toString('base64');
      await hide.evaluate((s) => {
        (s as Element).remove();
      });
      const worst = await page.evaluate(
        async ({ shownPng, barePng, fg, alpha }) => {
          const pixels = async (png: string): Promise<Uint8ClampedArray> => {
            const img = new Image();
            img.src = 'data:image/png;base64,' + png;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const g = c.getContext('2d');
            if (!g) {
              throw new Error('no canvas');
            }
            g.drawImage(img, 0, 0);
            return g.getImageData(0, 0, c.width, c.height).data;
          };
          const a = await pixels(shownPng);
          const b = await pixels(barePng);
          const m = (fg.match(/[\d.]+/g) ?? []).map(Number);
          const k = (m[3] ?? 1) * alpha;
          const lum = (rgb: number[]): number =>
            rgb
              .map((v) => {
                const x = v / 255;
                return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
              })
              .reduce((s, v, i) => s + v * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0);
          const seen = new Set<number>();
          let low = Infinity;
          let glyphs = 0;
          for (let i = 0; i < a.length; i += 4) {
            if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) {
              continue;
            }
            glyphs++;
            const key = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
            const bg = [b[i] ?? 0, b[i + 1] ?? 0, b[i + 2] ?? 0];
            const l1 = lum(bg.map((v, j) => (m[j] ?? 0) * k + v * (1 - k)));
            const l2 = lum(bg);
            low = Math.min(low, (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05));
          }
          return glyphs ? low : null;
        },
        { shownPng: shown, barePng: bare, fg: n.fg, alpha: n.alpha },
      );
      const need = n.large ? 4.5 : 7;
      if (worst === null) {
        out.push({ target: n.target, ratio: null, need });
      } else if (worst + 0.005 < need) {
        out.push({ target: n.target, ratio: worst, need });
      }
    }
  } finally {
    await freeze.evaluate((s) => {
      (s as Element).remove();
    });
  }
  return out;
}

// An exception covers one rule inside one container on pages its pattern names; * is one path segment.
export function exceptionsFor(exceptions: Exception[], path: string, rule: string): Exception[] {
  return exceptions.filter(
    (e) =>
      e.rule === rule &&
      new RegExp(`^${e.pages.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`).test(
        path,
      ),
  );
}

// An exception that matched nothing is stale and must be removed.
export function unusedExceptions(exceptions: Exception[], used: Set<Exception>): Exception[] {
  return exceptions.filter((e) => !used.has(e));
}
