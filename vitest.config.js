import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Several suites index the full FHIR StructureDefinition bundles in a
    // beforeAll hook (searches on those resource types silently return zero
    // results without it). That indexing takes ~1s when a file runs alone,
    // but the suite runs 53 files in parallel and the resulting CPU
    // contention pushes some hooks past the 10s default — surfacing as ten
    // failed *files* with zero failed tests. The work is legitimately slow,
    // not hung, so raise the ceiling rather than cap parallelism.
    hookTimeout: 60000,
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
