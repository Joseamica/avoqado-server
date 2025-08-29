import js from '@eslint/js'
import tsEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettierPlugin from 'eslint-plugin-prettier'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.js', '*.config.mjs'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        NodeJS: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsEslint,
      prettier: prettierPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsEslint.configs.recommended.rules,
      'prettier/prettier': 'error',
      'no-console': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true
      }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off', // Allow any type for flexibility
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-empty-object-type': 'off', // Allow {} type
      'no-case-declarations': 'off', // Allow declarations in case blocks
      'no-useless-escape': 'warn',
      'no-undef': 'off', // TypeScript handles this
    },
  },
  {
    files: ['**/seed.ts', '**/scripts/**/*.ts'],
    rules: {
      'no-console': 'off', // Allow console in seed files and scripts
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        NodeJS: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsEslint,
      prettier: prettierPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsEslint.configs.recommended.rules,
      'prettier/prettier': 'error',
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off', // Allow require in tests
    },
  },
]
