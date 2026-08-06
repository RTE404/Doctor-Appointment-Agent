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

  test('conditionally-creates the single HealthcareService by its identifier, not a chosen id', () => {
    const officeVisit = bundle.entry.find((e: any) => e.resource?.resourceType === 'HealthcareService');
    // No super-admin login can choose a resource's id (Medplum's
    // canSetId()), so this bootstrap bundle can't rely on PUT-by-chosen-id
    // any more than the per-patient seed pipeline can — see SuperAdmin_Issue.md.
    expect(officeVisit.resource.id).toBeUndefined();
    expect(officeVisit.request).toStrictEqual({
      method: 'POST',
      url: 'HealthcareService',
      ifNoneExist: 'identifier=http://example.com/agent-config|office-visit',
    });
    expect(officeVisit.resource.identifier).toContainEqual({ system: 'http://example.com/agent-config', value: 'office-visit' });
    // There is no second "Urgent Visit" HealthcareService — no urgency/triage
    // classification exists in this product (decision recorded 2026-08-06).
    expect(bundle.entry.find((e: any) => e.resource?.identifier?.some((i: any) => i.value === 'urgent-visit'))).toBeUndefined();
  });

  test('conditionally-creates the ai-appointment-agent Device by its identifier', () => {
    const device = bundle.entry.find((e: any) => e.resource?.resourceType === 'Device');
    expect(device.resource.id).toBeUndefined();
    expect(device.request).toStrictEqual({
      method: 'POST',
      url: 'Device',
      ifNoneExist: 'identifier=http://example.com/agent-config|ai-appointment-agent',
    });
  });

  test('conditionally-creates the CodeSystem by its canonical url, covering ai-previsit-summary and ai-chat', () => {
    const codeSystem = bundle.entry.find((e: any) => e.resource?.resourceType === 'CodeSystem');
    expect(codeSystem.resource.id).toBeUndefined();
    expect(codeSystem.request).toStrictEqual({
      method: 'POST',
      url: 'CodeSystem',
      ifNoneExist: 'url=http://example.com/agent-communication-category',
    });
    const codes = codeSystem.resource.concept.map((c: any) => c.code);
    expect(codes).toContain('ai-previsit-summary');
    expect(codes).toContain('ai-chat');
  });

  test('conditionally-creates the ValueSet by its canonical url', () => {
    const valueSet = bundle.entry.find((e: any) => e.resource?.resourceType === 'ValueSet');
    expect(valueSet.resource.id).toBeUndefined();
    expect(valueSet.request).toStrictEqual({
      method: 'POST',
      url: 'ValueSet',
      ifNoneExist: 'url=http://example.com/agent-communication-category-vs',
    });
  });
});
