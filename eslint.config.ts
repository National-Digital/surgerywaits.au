import { readFileSync } from 'node:fs';
import { recommended as comments } from '@eslint-community/eslint-plugin-eslint-comments/configs';
import js from '@eslint/js';
import css from '@eslint/css';
import astro from 'eslint-plugin-astro';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { astroStyles } from './eslint/astro-styles.ts';
import { siteCss } from './eslint/plugin.ts';

// Media queries cannot read custom properties, so the scale is read from the --bp-* tokens.
const BREAKPOINTS = [
  ...readFileSync(`${import.meta.dirname}/site/src/styles/settings/layout.css`, 'utf8').matchAll(
    /--bp-[a-z]+:\s*(\d+px);/g,
  ),
].map((m) => m[1] ?? '');

const scriptFiles = ['**/*.{js,mjs,cjs,ts,mts,cts,astro}', '**/*.astro/*.{js,ts}'];

export default defineConfig(
  {
    ignores: [
      '**/dist/',
      '**/dist-preview/',
      '**/.astro/',
      '**/coverage/',
      '**/node_modules/',
      'pipeline/',
      'eslint/fixtures/',
      'worker/worker-configuration.d.ts',
    ],
  },
  {
    files: scriptFiles,
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      comments,
      astro.configs['flat/recommended'],
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.astro'],
      },
    },
    rules: {
      '@eslint-community/eslint-comments/require-description': 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/strict-boolean-expressions': 'error',
    },
  },
  {
    files: ['**/*.mjs', 'eslint.config.ts', 'vitest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  { files: ['**/*.astro'], processor: astroStyles },
  {
    // The tool's DOM names live in dom.ts; every other tool module holds no copy.
    files: ['site/src/tool/*.ts', 'eslint/fixtures/text-*.ts'],
    ignores: ['site/src/tool/dom.ts', 'site/src/tool/*.test.ts'],
    plugins: { site: siteCss },
    rules: { 'site/no-literal-text': 'error' },
  },
  {
    files: ['site/src/**/*.astro', 'eslint/fixtures/text-*.astro'],
    plugins: { site: siteCss },
    rules: { 'site/no-literal-text': 'error' },
  },
  {
    // Fixtures sit outside every tsconfig, so they are parsed without type information.
    files: ['eslint/fixtures/text-*.astro', 'eslint/fixtures/text-*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { parserOptions: { projectService: false, project: null } },
  },
  {
    files: ['**/*.css', '**/*.astro/*.css'],
    language: 'css/css',
    plugins: { css, site: siteCss },
    extends: [css.configs.recommended],
    rules: {
      // Tokens are defined once in the settings layer, so other files cannot trace them.
      'css/no-invalid-properties': ['error', { allowUnknownVariables: true }],
      'site/bem-class-name': 'error',
      'site/token-values': 'error',
      'site/breakpoint-scale': ['error', { allowed: BREAKPOINTS }],
      'site/layer-declared': 'error',
      // em sizes inline text, such as code, relative to the text around it.
      'css/relative-font-units': ['error', { allowUnits: ['rem', 'em'] }],
      'css/selector-complexity': ['error', { maxIds: 0, maxClasses: 3 }],
      'css/use-baseline': [
        'error',
        {
          // Each is progressive: engines without it keep their defaults.
          allowAtRules: ['page'],
          allowProperties: ['orphans', 'text-size-adjust', 'widows'],
          allowPropertyValues: { 'text-wrap': ['balance'] },
        },
      ],
    },
  },
  {
    // The rule callbacks take their types from the plugin's rule definitions.
    files: ['eslint/*.ts', 'eslint/rules/*.ts'],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },
  {
    // !important is allowed in utilities and print only (ADR 0001 D18).
    files: ['site/src/styles/utilities/*.css', 'site/src/styles/print/print.css'],
    rules: { 'css/no-important': 'off' },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
);
