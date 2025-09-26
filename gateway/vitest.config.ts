import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Align with root config: long-running integration tests (plan/stream)
    testTimeout: 30,
    environment: 'node',
    // Run gateway-local tests when invoked from this directory
    include: ['tests/**/*.test.{js,ts}'],
    exclude: ['rooms/tests/**', 'memory/tests/**', 'node_modules/**'],
    // No external stubs; tests use internal stubs where needed
    setupFiles: [],
  },
});
