import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*',
      // Gitignored reference clones kept at project root for source fact-checking
      // (see root .gitignore) — not part of this project, must not be test-collected.
      '**/medplum/**',
      '**/medplum-scheduling-demo/**',
    ],
  },
});
