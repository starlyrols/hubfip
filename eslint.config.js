'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'data/**', 'coverage/**', '.claude/**'] },
  js.configs.recommended,
  {
    // Code serveur / modules / scripts / tests (Node, CommonJS)
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Code navigateur (scripts globaux chargés via <script>)
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        Chart: 'readonly',
        L: 'readonly',
        HubCharts: 'writable',
        HubMap: 'writable',
        SumoTheme: 'readonly',
      },
    },
  },
  {
    // La config ESLint elle-même
    files: ['eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
];
