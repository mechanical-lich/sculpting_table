import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  {
    // core/ must stay free of DOM and framework imports.
    files: ['src/core/**/*.ts'],
    languageOptions: { globals: { ...globals.es2022 } },
  },
  { ignores: ['dist', 'node_modules'] },
);
