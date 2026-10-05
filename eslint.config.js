// @ts-check
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'coverage/',
      'playwright-report/',
      'test-results/',
      'node_modules/',
      'src/web/styles/tokens.css',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // Logging goes through pino so that redaction applies; console is only for CLIs and scripts.
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Our own field components forward autoFocus to a single, documented place (components/ui.tsx).
      'jsx-a11y/no-autofocus': ['error', { ignoreNonDOM: true }],
      // Headings and the main region receive programmatic focus on navigation so screen readers announce the new page.
      'jsx-a11y/no-noninteractive-tabindex': [
        'error',
        { tags: [], roles: ['heading', 'main', 'region', 'alert'] },
      ],
    },
  },
  {
    files: [
      'scripts/**',
      'src/server/cli.ts',
      'src/server/migrate.ts',
      'tests/**',
      '*.config.{js,ts}',
    ],
    rules: { 'no-console': 'off' },
  },
);
