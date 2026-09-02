import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },

    /**
     * Coverage is reported over the logic that decides what a citizen is told —
     * the engine, the guardrails, the schemas and the retrieval layer. React
     * components and API route handlers are excluded deliberately: they are
     * exercised end to end by the evaluation suite, and counting their lines
     * here would inflate the number without testing anything more.
     *
     * Thresholds are floors, not targets. They exist so a change that quietly
     * removes a test fails the build instead of passing quietly.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: [
        'src/lib/engine/**/*.ts',
        'src/lib/guardrails/**/*.ts',
        'src/lib/schemas/**/*.ts',
        'src/lib/retrieval/**/*.ts',
        'src/lib/i18n/**/*.ts',
        'src/lib/config/**/*.ts',
      ],
      exclude: ['**/*.d.ts', '**/index.ts'],
      // Measured on the full suite at 1.0.0: statements 70.74, branches
      // 77.21, functions 81.48. Floors sit a few points under each, so normal
      // churn does not trip them and a deleted test does.
      thresholds: {
        lines: 65,
        functions: 75,
        branches: 72,
        statements: 65,
      },
    },
  },
});
