import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.test.ts'],
    },
  },
  resolve: {
    alias: {
      '@linksphere/core': path.resolve(__dirname, '../../packages/core/src'),
    },
  },
});