import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AudioContext: 'readonly',
        navigator: 'readonly',
        MediaStream: 'readonly',
        Float32Array: 'readonly',
        Int16Array: 'readonly',
        ArrayBuffer: 'readonly',
        setImmediate: 'readonly',
        Buffer: 'readonly',
        process: 'readonly',
        require: 'readonly', // allow require in some files (lifecycle.ts for dynamic imports)
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'off', // require() used for dynamic imports (Lifecycle.ts onnxbackend)
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-console': 'off',
      'no-empty': 'off',
      'prefer-const': 'warn',
      'preserve-caught-error': 'off',
      'no-undef': 'off', // handled by TypeScript
    },
  },
  {
    ignores: ['dist-electron/', 'out/', 'node_modules/', '*.js', '*.cjs', '*.mjs'],
  },
)
