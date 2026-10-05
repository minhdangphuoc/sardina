// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'test/fixtures/**', '.vscode-test/**'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            '*.mjs',
            'test/*.ts',
            'test/integration/*.ts',
            'test/unit/fake/*.ts',
            'test/unit/project/*.ts',
            'test/unit/settings/*.ts',
            'test/unit/devices/*.ts',
            'test/unit/qtqml/*.ts',
            'test/unit/snippets/*.ts',
            'test/unit/wizard/*.ts',
            'test/unit/targets/*.ts',
            'test/unit/tasks/*.ts', 'test/unit/debug/*.ts',
            'test/unit/agent/*.ts',
            'test/unit/sfdk/*.ts',
            'test/fuzz/*.ts',
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 200,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Escape hatch: use `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- justification`
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
