import type { CSSRuleDefinition } from '@eslint/css';
import { span } from './walk.ts';

const WORD = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const BEM = new RegExp(`^[ocu]-${WORD}(?:__${WORD})?(?:--${WORD})?$`);
const HOOK = new RegExp(`^(?:is|has|js)-${WORD}$`);

export const bemClassName: CSSRuleDefinition<{
  MessageIds: 'badClass' | 'classAttribute';
  RuleOptions: [];
}> = {
  meta: {
    type: 'problem',
    docs: { description: 'Require class names to follow the ITCSS prefixes and BEM naming (D18)' },
    messages: {
      badClass:
        '".{{name}}" is not a valid class: use o-, c- or u- with block__element--modifier, or is-, has- or js-.',
      classAttribute: 'Select a class with its .name, not a [class] attribute selector.',
    },
    schema: [],
  },
  create(context) {
    const check = (name: string, loc: ReturnType<typeof span>): void => {
      if (!BEM.test(name) && !HOOK.test(name)) {
        context.report({ loc, messageId: 'badClass', data: { name } });
      }
    };
    return {
      ClassSelector(node) {
        check(node.name, span(node));
      },
      AttributeSelector(node) {
        if (node.name.name.toLowerCase() === 'class') {
          context.report({ loc: span(node), messageId: 'classAttribute' });
        }
      },
      // Astro's :global(...) argument stays raw text, so read its classes from the string.
      Raw(node) {
        for (const m of node.value.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) {
          check(m[1] ?? '', span(node));
        }
      },
    };
  },
};
