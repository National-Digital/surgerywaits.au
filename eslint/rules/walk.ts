import type { CssLocationRange, CssNodePlain } from '@eslint/css-tree';

function isNode(value: unknown): value is CssNodePlain {
  return typeof value === 'object' && value !== null && 'type' in value;
}

// Visits a node and every descendant, whether held in children or in a named field.
export function walk(node: CssNodePlain, visit: (n: CssNodePlain) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') {
      continue;
    }
    for (const child of Array.isArray(value) ? (value as unknown[]) : [value]) {
      if (isNode(child)) {
        walk(child, visit);
      }
    }
  }
}

const START = { line: 1, column: 1, offset: 0 };

// The parser always sets locations; the fallback only satisfies the type.
export function span(node: { loc?: CssLocationRange | null }): CssLocationRange {
  return node.loc ?? { source: '', start: START, end: START };
}
