import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 300000, // 5 minutes
    include: ['gateway/tests/**/*.test.js', 'gateway/**/tests/**/*.test.js', 'tests/**/*.test.{js,ts}'],
    exclude: ['gateway/rooms/tests/**', 'gateway/memory/tests/**', 'node_modules/**'],
    environment: 'node',
    setupFiles: ['tests/setup/start-llama-server.js'],
  },
});
