import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
import type { AstroComponentFactory } from 'astro/runtime/server/index.js';

let container: Promise<AstroContainer> | undefined;

// Rendering follows Astro's container API: https://docs.astro.build/en/reference/container-reference/
export async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
  container ??= AstroContainer.create();
  return (await container).renderToString(component as AstroComponentFactory, { props });
}

type Node = DefaultTreeAdapterTypes.Node;

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      walk(child, visit);
    }
  }
}

function plain(node: Node): string {
  if ('value' in node) {
    return node.value;
  }
  if (!('childNodes' in node) || node.nodeName === 'style') {
    return '';
  }
  return node.childNodes.map(plain).join(' ');
}

export function text(html: string): string {
  return plain(parseFragment(html)).replace(/\s+/g, ' ').trim();
}

// The text of every element that carries a class, in document order.
export function textsOf(html: string, className: string): string[] {
  const found: string[] = [];
  walk(parseFragment(html), (node) => {
    if (
      'attrs' in node &&
      node.attrs.some((a) => a.name === 'class' && a.value.split(' ').includes(className))
    ) {
      found.push(plain(node).replace(/\s+/g, ' ').trim());
    }
  });
  return found;
}
