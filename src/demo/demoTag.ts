import type { Coding, Meta } from '@medplum/fhirtypes';

export const DEMO_GENERATED_TAG: Coding = {
  system: 'https://doctor-appointment-agent.example/fhir/demo',
  code: 'demo-generated',
};

export const DEMO_GENERATED_TAG_SEARCH = `${DEMO_GENERATED_TAG.system}|${DEMO_GENERATED_TAG.code}`;

export function isDemoGenerated(meta?: Meta): boolean {
  return (
    meta?.tag?.some(
      (tag) => tag.system === DEMO_GENERATED_TAG.system && tag.code === DEMO_GENERATED_TAG.code
    ) ?? false
  );
}

export function withDemoGeneratedTag(meta?: Meta): Meta {
  const tags = meta?.tag ?? [];
  const alreadyTagged = tags.some(
    (tag) => tag.system === DEMO_GENERATED_TAG.system && tag.code === DEMO_GENERATED_TAG.code
  );
  return {
    ...meta,
    tag: alreadyTagged ? [...tags] : [...tags, { ...DEMO_GENERATED_TAG }],
  };
}
