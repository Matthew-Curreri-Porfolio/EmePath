import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30,
    include: ['gateway/tests/**/*.test.js', 'gateway/**/tests/**/*.test.js', 'tests/**/*.test.{js,ts}'],
    exclude: ['gateway/rooms/tests/**', 'gateway/memory/tests/**', 'gateway/node_modules/**', 'node_modules/**'],
    environment: 'node',
    setupFiles: ['tests/setup/start-llama-server.js'],
  },
});
