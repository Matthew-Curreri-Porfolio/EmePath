import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests hit a local stub server and can take
    // several seconds (including intentional upstream timeouts).
    // Increase the timeouts to avoid flaky failures.
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['gateway/tests/**/*.test.js', 'gateway/**/tests/**/*.test.js', 'tests/**/*.test.{js,ts}'],
    exclude: ['gateway/rooms/tests/**', 'gateway/memory/tests/**', 'gateway/node_modules/**', 'node_modules/**'],
    environment: 'node',
    setupFiles: ['tests/setup/start-llama-server.js'],
  },
});
