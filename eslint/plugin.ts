import { bemClassName } from './rules/bem-class-name.ts';
import { breakpointScale } from './rules/breakpoint-scale.ts';
import { layerDeclared } from './rules/layer-declared.ts';
import { tokenValues } from './rules/token-values.ts';

export const siteCss = {
  meta: { name: 'site-css' },
  rules: {
    'bem-class-name': bemClassName,
    'layer-declared': layerDeclared,
    'token-values': tokenValues,
    'breakpoint-scale': breakpointScale,
  },
};
