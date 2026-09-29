import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'coverage/**', '.e2e-userdata/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: { globals: { ...globals.node }, ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.property.name='innerHTML']", message: 'No uses innerHTML.' },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/ui/**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-restricted-properties': ['error', { property: 'dangerouslySetInnerHTML', message: 'Prohibido: riesgo de XSS.' }],
    },
  },
  {
    // Callbacks passed to page.evaluate() run in the browser.
    files: ['scripts/e2e.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // The renderer must never import Node/Electron or the core (everything goes through IPC).
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['electron', 'node:*', '**/core/**', '**/main/**'] }],
    },
  },
  {
    // The core must stay independent of Electron.
    files: ['src/core/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['electron', '**/main/**', '**/renderer/**'] }] },
  },
);
