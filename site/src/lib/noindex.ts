import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';

type Parent = DefaultTreeAdapterTypes.ParentNode;

const attr = (node: DefaultTreeAdapterTypes.Element, name: string): string | undefined =>
  node.attrs.find((a) => a.name === name)?.value;

// A robots meta tag keeps a page out of the index with `noindex` or `none`, in any case or order.
export function hasNoindex(html: string): boolean {
  const walk = (node: Parent): boolean =>
    node.childNodes.some((child) => {
      if ('tagName' in child && child.tagName === 'meta') {
        const tokens = (attr(child, 'content') ?? '').toLowerCase().split(/[\s,]+/u);
        return (
          attr(child, 'name')?.trim().toLowerCase() === 'robots' &&
          (tokens.includes('noindex') || tokens.includes('none'))
        );
      }
      return 'childNodes' in child && walk(child);
    });
  return walk(parse(html));
}
