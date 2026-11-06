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

// A selector is a class name, or a tag name such as td.
function matches(node: Node, selector: string): boolean {
  return node.nodeName === selector || classesOf(node).includes(selector);
}

// The text of every element that carries a class, in document order.
export function textsOf(html: string, className: string): string[] {
  const found: string[] = [];
  walk(parseFragment(html), (node) => {
    if (matches(node, className)) {
      found.push(plain(node).replace(/\s+/g, ' ').trim());
    }
  });
  return found;
}

export interface Found {
  classes: Set<string>;
  // Every class on an element inside this one.
  inside: Set<string>;
  text: string;
}

function classesOf(node: Node): string[] {
  if (!('attrs' in node)) {
    return [];
  }
  return (node.attrs.find((a) => a.name === 'class')?.value ?? '').split(' ').filter(Boolean);
}

function below(node: Node): Set<string> {
  const out = new Set<string>();
  walk(node, (n) => {
    if (n !== node) {
      classesOf(n).forEach((c) => out.add(c));
    }
  });
  return out;
}

// Each element that carries the class, with its own classes and those inside it.
export function elementsOf(html: string, className: string): Found[] {
  const found: Found[] = [];
  walk(parseFragment(html), (node) => {
    const classes = classesOf(node);
    if (matches(node, className)) {
      found.push({
        classes: new Set(classes),
        inside: below(node),
        text: plain(node).replace(/\s+/g, ' ').trim(),
      });
    }
  });
  return found;
}
