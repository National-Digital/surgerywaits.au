import { getGuides, getGuidesIndex } from './content';
import type { ArticleSection } from './content-schema';
import { fillSections, fillText, LIVE_LIMITS, methodologyFacts } from './article-pages';
import { surgeryStamp } from './index-pages';
import { categories } from './urgency-page';

export const GUIDES_PATH = '/guides/';
export const GP_PATH = '/gp/';

const guidePath = (slug: string): string => `${GUIDES_PATH}${slug}/`;

// The numbers the guides and the GP page state, from the site's code and the pipeline's rules.
export function guideFacts(): Record<string, string> {
  const base = methodologyFacts();
  const { period, release } = surgeryStamp();
  const [one, two, three] = categories();
  if (one === undefined || two === undefined || three === undefined) {
    throw new RangeError('the guides need the three urgency categories');
  }
  return {
    neighbours: base['neighbours'] ?? '',
    border_radius: String(LIVE_LIMITS.borderRadiusKm),
    border_count: String(LIVE_LIMITS.borderCount),
    volume_floor: String(LIVE_LIMITS.volumeFloor),
    long_wait_days: base['long_wait_days'] ?? '',
    first_within: one.within,
    second_within: two.within,
    third_within: three.within,
    period,
    release,
  };
}

export interface Guide {
  slug: string;
  path: string;
  summary: string;
  crumb: string;
  heading: string;
  title: string;
  description: string;
  crumbHome: string;
  lede: string;
  sections: ArticleSection[];
}

// The index names the order, and a guide missing from it or named twice stops the build.
export function guides(): Guide[] {
  const all = getGuides();
  const order = getGuidesIndex().order;
  if ([...order].sort().join() !== [...all.keys()].sort().join()) {
    throw new RangeError('the guides index order and the guide files do not match');
  }
  const facts = guideFacts();
  return order.map((slug) => {
    const g = all.get(slug);
    if (g === undefined) {
      throw new RangeError(`no guide ${slug}`);
    }
    return {
      slug,
      path: guidePath(slug),
      summary: g.summary,
      crumb: g.crumb,
      heading: fillText(g.heading, facts),
      title: g.title,
      description: g.description,
      crumbHome: g.crumb_home,
      lede: fillText(g.lede, facts),
      sections: fillSections(g.sections, facts),
    };
  });
}

export function guideOf(slug: string): Guide {
  const found = guides().find((g) => g.slug === slug);
  if (found === undefined) {
    throw new RangeError(`no guide ${slug}`);
  }
  return found;
}
