import type { Rule } from 'eslint';

const TEXT = /[\p{L}\p{N}]/u;

// Attributes that carry a value a person never reads. Every other attribute is treated as copy.
const NON_COPY = new Set([
  'action',
  'as',
  'autocomplete',
  'charset',
  'class',
  'class:list',
  'crossorigin',
  'decoding',
  'for',
  'height',
  'href',
  'http-equiv',
  'id',
  'inputmode',
  'lang',
  'loading',
  'media',
  'method',
  'name',
  'rel',
  'role',
  'sizes',
  'slot',
  'src',
  'srcset',
  'tabindex',
  'target',
  'type',
  'width',
  'aria-controls',
  'aria-current',
  'aria-describedby',
  'aria-expanded',
  'aria-haspopup',
  'aria-hidden',
  'aria-labelledby',
  'aria-live',
]);
// The only values a scope attribute takes; any other string is treated as copy.
const SCOPE_VALUES = new Set(['col', 'row', 'colgroup', 'rowgroup']);
// A meta tag's content is not copy when its name says so.
const META_NON_COPY = new Set(['viewport', 'theme-color', 'color-scheme', 'robots']);
// Calls whose string arguments name a content key, not text.
const KEY_CALLS = new Set(['label', 'getPage', 'getEntry', 'getCollection']);
const COMPARE = new Set(['==', '===', '!=', '!==', 'in', 'instanceof']);

interface Node {
  type: string;
  parent?: Node;
  name?: { name?: string | { name?: string }; namespace?: { name?: string } };
  value?: unknown;
  raw?: string;
  operator?: string;
  test?: Node;
  key?: Node;
  expression?: Node;
  callee?: Node & { name?: string };
  openingElement?: { name?: { name?: string }; attributes?: Node[] };
  quasis?: { value: { cooked?: string | null } }[];
}

function attrName(node: Node): string {
  const { name } = node;
  if (typeof name?.name === 'string') {
    return name.name;
  }
  return `${name?.namespace?.name ?? ''}:${name?.name?.name ?? ''}`;
}

function inTemplate(node: Node): boolean {
  for (let up = node.parent; up; up = up.parent) {
    if (up.type === 'AstroFragment' || up.type.startsWith('JSX')) {
      return true;
    }
  }
  return false;
}

// JSON-LD is data the page describes itself with, and its text comes from the same content as the page.
function jsonLdScript(attr: Node): boolean {
  const element = attr.parent;
  return (
    element?.type === 'JSXOpeningElement' &&
    element.parent?.openingElement?.name?.name === 'script' &&
    (element.parent.openingElement.attributes ?? []).some(
      (a) =>
        a.type === 'JSXAttribute' &&
        attrName(a) === 'type' &&
        (a.value as Node | undefined)?.value === 'application/ld+json',
    )
  );
}

// Only a call to serialise(...) may fill the block, so no literal string reaches it.
function serialised(attr: Node): boolean {
  const call = (attr.value as Node | undefined)?.expression;
  return call?.type === 'CallExpression' && call.callee?.name === 'serialise';
}

function hidden(node: Node): boolean {
  for (let up = node.parent; up; up = up.parent) {
    const tag = up.openingElement?.name?.name;
    if (tag === 'style' || tag === 'script') {
      return true;
    }
  }
  return false;
}

function metaNonCopy(attr: Node): boolean {
  const element = attr.parent?.parent;
  if (element?.openingElement?.name?.name !== 'meta') {
    return false;
  }
  return (element.openingElement.attributes ?? []).some(
    (a) =>
      a.type === 'JSXAttribute' &&
      attrName(a) === 'name' &&
      META_NON_COPY.has(String((a.value as Node | undefined)?.value)),
  );
}

function copyAttribute(attr: Node): boolean {
  const name = attrName(attr);
  if (name === 'content' && metaNonCopy(attr)) {
    return false;
  }
  if (name === 'scope') {
    return !SCOPE_VALUES.has(String((attr.value as Node | undefined)?.value));
  }
  return !(NON_COPY.has(name) || name.startsWith('data-'));
}

// Walks up to the nearest expression container or attribute; only a few positions are exempt.
function destination(node: Node): 'child' | 'attribute' | 'key' | 'other' {
  let child = node;
  for (let up = node.parent; up; child = up, up = up.parent) {
    if (up.type === 'ConditionalExpression' && up.test === child) {
      return 'other';
    }
    if (up.type === 'BinaryExpression' && COMPARE.has(up.operator ?? '')) {
      return 'other';
    }
    if (up.type === 'Property' && up.key === child) {
      return 'other';
    }
    if (
      up.type === 'CallExpression' &&
      up.callee !== child &&
      KEY_CALLS.has(up.callee?.name ?? '')
    ) {
      return 'other';
    }
    if (up.type === 'JSXExpressionContainer') {
      return up.parent?.type === 'JSXAttribute' ? 'attribute' : 'child';
    }
    if (up.type === 'JSXSpreadAttribute') {
      return 'child';
    }
    if (up.type === 'JSXAttribute') {
      return 'attribute';
    }
    if (up.type === 'AstroFragment' || up.type === 'Program') {
      return 'other';
    }
  }
  return 'other';
}

export const noLiteralText: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Fail on literal user-visible text in a template or its frontmatter (D10)',
    },
    messages: {
      text: 'Literal text "{{text}}" belongs in YAML under site/content/, read through the content accessors.',
      html: '{{name}} puts text outside the content files; render the content string as an element.',
    },
    schema: [],
  },
  create(context) {
    const report = (node: Node, text: string): void => {
      context.report({
        node: node as unknown as Rule.Node,
        messageId: 'text',
        data: { text: text.trim().slice(0, 40) },
      });
    };
    // The Astro parser's JSX nodes are not in ESLint's types, so read them through Node.
    const on = (fn: (node: Node) => void) => (node: Rule.Node) => {
      fn(node as unknown as Node);
    };

    const inFrontmatter = (node: Node, text: string): void => {
      const { parent } = node;
      if (parent === undefined || parent.type === 'ImportDeclaration') {
        return;
      }
      if (parent.type === 'TSLiteralType' || parent.type === 'ExportAllDeclaration') {
        return;
      }
      if (parent.type === 'Property' && parent.key === node) {
        return;
      }
      if (parent.type === 'CallExpression' && KEY_CALLS.has(parent.callee?.name ?? '')) {
        return;
      }
      report(node, text);
    };

    const check = (node: Node, text: string): void => {
      if (!TEXT.test(text) || hidden(node)) {
        return;
      }
      if (!inTemplate(node)) {
        inFrontmatter(node, text);
        return;
      }
      const where = destination(node);
      if (where === 'child') {
        report(node, text);
      } else if (where === 'attribute') {
        let up: Node | undefined = node.parent;
        while (up && up.type !== 'JSXAttribute') {
          up = up.parent;
        }
        if (up && copyAttribute(up)) {
          report(node, text);
        }
      }
    };

    return {
      JSXText: on((node) => {
        if (typeof node.value === 'string' && TEXT.test(node.value) && !hidden(node)) {
          report(node, node.value);
        }
      }),
      JSXAttribute: on((node) => {
        const name = attrName(node);
        if (
          (name === 'set:html' || name === 'set:text') &&
          !(name === 'set:html' && jsonLdScript(node) && serialised(node))
        ) {
          context.report({
            node: node as unknown as Rule.Node,
            messageId: 'html',
            data: { name },
          });
          return;
        }
        const value = node.value as Node | null | undefined;
        if (value?.type === 'Literal' && typeof value.value === 'string') {
          if (TEXT.test(value.value) && copyAttribute(node)) {
            report(node, value.value);
          }
        }
      }),
      Literal: on((node) => {
        if (typeof node.value === 'string' && node.parent?.type !== 'JSXAttribute') {
          check(node, node.value);
        }
      }),
      TemplateLiteral: on((node) => {
        check(node, node.quasis?.map((q) => q.value.cooked ?? '').join(' ') ?? '');
      }),
    };
  },
};
