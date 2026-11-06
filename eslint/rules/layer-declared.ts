import type { CSSRuleDefinition } from '@eslint/css';
import { span, walk } from './walk.ts';

const LAYERS = ['print', 'settings', 'generic', 'elements', 'objects', 'components', 'utilities'];

export const layerDeclared: CSSRuleDefinition<{
  MessageIds: 'unknownLayer' | 'wrongOrder' | 'unlayered' | 'strayOrder';
  RuleOptions: [];
}> = {
  meta: {
    type: 'problem',
    docs: { description: 'Require every style rule to sit in one of the ITCSS layers (D18)' },
    messages: {
      unknownLayer: '"{{name}}" is not an ITCSS layer: use {{layers}}.',
      wrongOrder: 'The layer order must be {{layers}}.',
      strayOrder: 'Declare the layer order only in site/src/styles/layers.css.',
      unlayered: 'Put this rule inside an @layer block.',
    },
    schema: [],
  },
  create(context) {
    let layerDepth = 0;
    let keyframeDepth = 0;
    const layerNames = (node: Parameters<typeof walk>[0]): string[] => {
      const names: string[] = [];
      walk(node, (n) => {
        if (n.type === 'Layer') {
          names.push(n.name);
        }
      });
      return names;
    };
    const layers = LAYERS.join(', ');
    const isLayersFile = context.filename
      .replaceAll('\\', '/')
      .endsWith('site/src/styles/layers.css');
    return {
      Atrule(node) {
        const name = node.name.toLowerCase();
        if (name.endsWith('keyframes')) {
          keyframeDepth += 1;
        }
        if (name !== 'layer' && name !== 'import') {
          return;
        }
        if (name === 'layer' && node.block !== null) {
          layerDepth += 1;
        }
        const names = node.prelude === null ? [] : layerNames(node.prelude);
        for (const layer of names) {
          if (!LAYERS.includes(layer)) {
            context.report({
              loc: span(node),
              messageId: 'unknownLayer',
              data: { name: layer, layers },
            });
          }
        }
        if (name === 'layer' && node.block === null) {
          if (!isLayersFile) {
            context.report({ loc: span(node), messageId: 'strayOrder' });
          } else if (names.join() !== LAYERS.join()) {
            context.report({ loc: span(node), messageId: 'wrongOrder', data: { layers } });
          }
        }
      },
      'Atrule:exit'(node) {
        const name = node.name.toLowerCase();
        if (name.endsWith('keyframes')) {
          keyframeDepth -= 1;
        }
        if (name === 'layer' && node.block !== null) {
          layerDepth -= 1;
        }
      },
      Rule(node) {
        if (layerDepth === 0 && keyframeDepth === 0) {
          context.report({ loc: span(node), messageId: 'unlayered' });
        }
      },
    };
  },
};
