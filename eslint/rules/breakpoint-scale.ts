import type { CSSRuleDefinition } from '@eslint/css';
import { span, walk } from './walk.ts';

export const breakpointScale: CSSRuleDefinition<{
  MessageIds: 'offScale';
  RuleOptions: [{ allowed: string[] }];
}> = {
  meta: {
    type: 'problem',
    docs: {
      description: "Require media query widths to come from the site's breakpoint tokens (D18)",
    },
    messages: { offScale: '"{{value}}" is not on the breakpoint scale: use {{allowed}}.' },
    schema: [
      {
        type: 'object',
        properties: { allowed: { type: 'array', items: { type: 'string' } } },
        required: ['allowed'],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const allowed = context.options[0].allowed;
    return {
      Atrule(node) {
        if (node.name.toLowerCase() !== 'media' || node.prelude === null) {
          return;
        }
        walk(node.prelude, (n) => {
          if (n.type !== 'Dimension' || /^(?:dpi|dpcm|dppx|x)$/i.test(n.unit)) {
            return;
          }
          const value = `${n.value}${n.unit}`;
          if (Number.parseFloat(n.value) !== 0 && !allowed.includes(value)) {
            context.report({
              loc: span(n),
              messageId: 'offScale',
              data: { value, allowed: allowed.join(', ') },
            });
          }
        });
      },
    };
  },
};
