// tools/seed/agent-config.test.ts
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';

// ESM has no __dirname; this is the standard replacement (matches index.ts's Task 9 fix).
const __dirname = dirname(fileURLToPath(import.meta.url));

describe('data/core/agent-config.json', () => {
  const bundle = JSON.parse(readFileSync(join(__dirname, '../../data/core/agent-config.json'), 'utf-8'));

  test('is a transaction bundle', () => {
    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.type).toBe('transaction');
  });

  test('upserts the single HealthcareService at its fixed id', () => {
    const officeVisit = bundle.entry.find((e: any) => e.resource?.id === 'office-visit');
    expect(officeVisit.resource.resourceType).toBe('HealthcareService');
    expect(officeVisit.request).toStrictEqual({ method: 'PUT', url: 'HealthcareService/office-visit' });
    expect(officeVisit.resource.identifier).toContainEqual({ system: 'http://example.com/agent-config', value: 'office-visit' });
    // There is no second "Urgent Visit" HealthcareService — no urgency/triage
    // classification exists in this product (decision recorded 2026-08-06).
    expect(bundle.entry.find((e: any) => e.resource?.id === 'urgent-visit')).toBeUndefined();
  });

  test('creates the ai-appointment-agent Device', () => {
    const device = bundle.entry.find((e: any) => e.resource?.resourceType === 'Device');
    expect(device.resource.id).toBe('ai-appointment-agent');
    expect(device.request).toStrictEqual({ method: 'PUT', url: 'Device/ai-appointment-agent' });
  });

  test('creates a CodeSystem covering ai-previsit-summary and ai-chat', () => {
    const codeSystem = bundle.entry.find((e: any) => e.resource?.resourceType === 'CodeSystem');
    const codes = codeSystem.resource.concept.map((c: any) => c.code);
    expect(codes).toContain('ai-previsit-summary');
    expect(codes).toContain('ai-chat');
  });
});
