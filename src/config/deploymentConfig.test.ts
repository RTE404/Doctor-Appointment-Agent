import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

function readProjectFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('deployment configuration', () => {
  test('keeps the normal Vercel build independent from Bot deployment', () => {
    const packageJson = JSON.parse(readProjectFile('package.json')) as {
      engines: { node: string };
      scripts: { build: string };
    };

    expect(packageJson.engines.node).toBe('22.x');
    expect(packageJson.scripts.build).toBe('tsc && vite build');
    expect(packageJson.scripts.build).not.toContain('build:bots');
  });

  test('keeps Vercel routing and execution limits explicit', () => {
    const vercel = JSON.parse(readProjectFile('vercel.json')) as {
      functions: Record<string, { maxDuration: number }>;
      crons: { path: string; schedule: string }[];
      rewrites: { source: string; destination: string }[];
    };

    expect(vercel.functions['api/execute.ts'].maxDuration).toBe(60);
    expect(vercel.functions['api/demo-session.ts'].maxDuration).toBe(60);
    expect(vercel.functions['api/reset-demo.ts'].maxDuration).toBe(60);
    expect(vercel.crons).toEqual([{ path: '/api/reset-demo', schedule: '30 20 * * *' }]);
    expect(vercel.rewrites).toEqual([{ source: '/(.*)', destination: '/index.html' }]);
  });

  test('keeps browser configuration limited to approved public Medplum values', () => {
    const viteConfig = readProjectFile('vite.config.ts');
    const publicConfig = readProjectFile('src/config.ts');
    const defaults = readProjectFile('.env.defaults');

    expect(viteConfig).not.toContain('GOOGLE_');
    expect(viteConfig).not.toContain('copyFileSync');
    expect(defaults).not.toContain('GOOGLE_');
    expect(defaults).not.toContain('GEMINI_API_KEY');
    expect(defaults).toMatch(/^DEMO_ACCESS_CODE=''$/m);
    expect(defaults).toMatch(/^DEMO_MEDPLUM_CLIENT_SECRET=''$/m);
    expect(defaults).toMatch(/^DEMO_WORKER_CLIENT_SECRET=''$/m);
    expect(defaults).toMatch(/^SEED_MEDPLUM_CLIENT_SECRET=''$/m);
    expect(defaults).not.toMatch(/^MEDPLUM_CLIENT_SECRET=/m);
    expect(defaults).toMatch(/^CRON_SECRET=''$/m);
    expect(publicConfig).not.toContain('clientId');
    expect(publicConfig).not.toContain('GEMINI_API_KEY');
    expect(publicConfig).not.toContain('DEMO_');
  });

  test('does not resume an old personal Medplum login from browser localStorage', () => {
    const main = readProjectFile('src/main.tsx');

    expect(main).toContain('storage: new ClientStorage(new MemoryStorage())');
    expect(main).toContain("medplum.addEventListener('change'");
  });

  test('uses a Vercel upload allowlist and ignores local Vercel state', () => {
    const vercelIgnore = readProjectFile('.vercelignore');
    const gitignore = readProjectFile('.gitignore');

    expect(vercelIgnore).toContain('/*');
    expect(vercelIgnore).toContain('!api');
    expect(vercelIgnore).toContain('!src');
    expect(vercelIgnore).not.toContain('!.env');
    expect(gitignore).toContain('.vercel/');
  });
});
