import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

function readProjectFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

describe('deployment configuration', () => {
  test('keeps the normal Vercel build independent from Bot deployment', () => {
    const packageJson = JSON.parse(readProjectFile('package.json')) as {
      engines: { node: string };
      scripts: { build: string };
    };

    expect(root).toContain('Doctor Appointment Agent');
    expect(packageJson.engines.node).toBe('22.x');
    expect(packageJson.scripts.build).toBe('tsc && vite build');
    expect(packageJson.scripts.build).not.toContain('build:bots');
  });

  test('keeps Vercel routing and execution limits explicit', () => {
    const vercel = JSON.parse(readProjectFile('vercel.json')) as {
      functions: Record<string, { maxDuration: number }>;
      rewrites: { source: string; destination: string }[];
    };

    expect(vercel.functions['api/execute.ts'].maxDuration).toBe(60);
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
    expect(defaults).not.toContain('MEDPLUM_CLIENT_SECRET');
    expect(publicConfig).not.toContain('GEMINI_API_KEY');
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
