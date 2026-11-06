import { parseTemplate } from 'astro-eslint-parser';
import type { Linter } from 'eslint';
import { processors } from 'eslint-plugin-astro';

const astro = processors['client-side-ts'];
const scriptBlockCounts = new Map<string, number>();

interface Span {
  start: number;
  end: number;
}

interface StyleElement {
  openingElement: Span;
  closingElement?: Span;
}

// The parser types template nodes as `type: unknown`, so check the shape it emits.
function isStyleElement(node: object): node is StyleElement {
  if (!('type' in node) || node.type !== 'JSXElement' || !('openingElement' in node)) {
    return false;
  }
  const opening = node.openingElement;
  return (
    typeof opening === 'object' &&
    opening !== null &&
    'name' in opening &&
    typeof opening.name === 'object' &&
    opening.name !== null &&
    'name' in opening.name &&
    opening.name.name === 'style'
  );
}

// Blanks everything outside each style body, so lines, columns and fix ranges match the .astro file.
function styleFiles(code: string): Linter.ProcessorFile[] {
  const blank = (text: string) => text.replaceAll(/[^\r\n]/g, ' ');
  const files: Linter.ProcessorFile[] = [];
  const parsed = parseTemplate(code);
  parsed.walk(parsed.result.ast, (node) => {
    if (!isStyleElement(node) || node.closingElement === undefined) {
      return;
    }
    const start = node.openingElement.end;
    const end = node.closingElement.start;
    files.push({
      text: blank(code.slice(0, start)) + code.slice(start, end) + blank(code.slice(end)),
      filename: `style-${String(files.length)}.css`,
    });
  });
  return files;
}

export const astroStyles: Linter.Processor = {
  meta: { name: 'astro-styles' },
  supportsAutofix: true,
  preprocess(code, filename) {
    const scripts = astro.preprocess?.(code, filename) ?? [code];
    scriptBlockCounts.set(filename, scripts.length);
    return [...scripts, ...styleFiles(code)];
  },
  postprocess(messages, filename) {
    const count = scriptBlockCounts.get(filename) ?? messages.length;
    scriptBlockCounts.delete(filename);
    const scripts =
      astro.postprocess?.(messages.slice(0, count), filename) ?? messages.slice(0, count).flat();
    return [...scripts, ...messages.slice(count).flat()];
  },
};
