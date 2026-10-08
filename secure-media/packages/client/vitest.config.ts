import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    // Client tests run in jsdom (browser-like environment)
    // shaka-player itself is not tested here — we test our wrappers only
    passWithNoTests: true,
  },
});
