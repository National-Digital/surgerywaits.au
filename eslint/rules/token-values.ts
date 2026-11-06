import type { CSSRuleDefinition } from '@eslint/css';
import type { AtrulePlain } from '@eslint/css-tree';
import { NAMED_COLORS } from './named-colors.ts';
import { span, walk } from './walk.ts';

const SPACING = /^(?:margin|padding|gap|row-gap|column-gap)(?:-|$)/;
const TIMING = /^(?:transition|animation)(?:-(?:duration|delay))?$/;
const COLOR_PROPERTY =
  /^(?:color|background(?:-color)?|border(?:-[a-z]+)*|outline(?:-color)?|fill|stroke|caret-color|accent-color|column-rule(?:-color)?|text-decoration(?:-color)?|box-shadow|text-shadow)$/;
const COLOR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
]);
// Scheme switching belongs in the settings layer; color-mix() of tokens is allowed anywhere (D18).
const SETTINGS_ONLY = new Set(['light-dark', 'color']);

export const tokenValues: CSSRuleDefinition<{
  MessageIds: 'raw' | 'settingsOnly';
  RuleOptions: [];
}> = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require spacing, colour and timing to come from custom properties (D18)',
    },
    messages: {
      raw: '"{{value}}" is a raw {{kind}}: use a token through var().',
      settingsOnly: '{{name}}() belongs in the settings layer: define a token there.',
    },
    schema: [],
  },
  create(context) {
    let settingsDepth = 0;
    const opensSettings = (node: AtrulePlain): boolean => {
      let found = false;
      if (node.name.toLowerCase() === 'layer' && node.block !== null && node.prelude !== null) {
        walk(node.prelude, (n) => {
          found ||= n.type === 'Layer' && n.name === 'settings';
        });
      }
      return found;
    };
    return {
      Atrule(node) {
        if (opensSettings(node)) {
          settingsDepth += 1;
        }
      },
      'Atrule:exit'(node) {
        if (opensSettings(node)) {
          settingsDepth -= 1;
        }
      },
      Declaration(node) {
        const custom = node.property.startsWith('--');
        const property = node.property.toLowerCase();
        if (node.value.type === 'Raw' && settingsDepth === 0) {
          // Custom property values stay unparsed, so look for the functions in the text.
          const m = /(?<![\w-])(light-dark|color)\(/i.exec(node.value.value);
          if (m !== null) {
            context.report({
              loc: span(node),
              messageId: 'settingsOnly',
              data: { name: m[1] ?? '' },
            });
          }
          return;
        }
        walk(node.value, (n) => {
          if (n.type === 'Function' && SETTINGS_ONLY.has(n.name.toLowerCase())) {
            if (settingsDepth === 0) {
              context.report({
                loc: span(n),
                messageId: 'settingsOnly',
                data: { name: n.name },
              });
            }
            return;
          }
          if (custom) {
            return;
          }
          let kind: string | undefined;
          let value = '';
          if (n.type === 'Hash') {
            kind = 'colour';
            value = `#${n.value}`;
          } else if (n.type === 'Function' && COLOR_FUNCTIONS.has(n.name.toLowerCase())) {
            kind = 'colour';
            value = `${n.name}()`;
          } else if (
            n.type === 'Identifier' &&
            COLOR_PROPERTY.test(property) &&
            NAMED_COLORS.has(n.name.toLowerCase())
          ) {
            kind = 'colour';
            value = n.name;
          } else if (n.type === 'Dimension' && Number.parseFloat(n.value) !== 0) {
            value = `${n.value}${n.unit}`;
            if (SPACING.test(property)) {
              kind = 'spacing value';
            } else if (TIMING.test(property) && /^m?s$/i.test(n.unit)) {
              kind = 'duration';
            }
          }
          if (kind !== undefined) {
            context.report({ loc: span(n), messageId: 'raw', data: { value, kind } });
          }
        });
      },
    };
  },
};
