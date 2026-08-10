import { describe, expect, test } from 'vitest';
import { LEGACY_PROVIDER_PATHS, getOperatorHomePath, getOperatorMenus } from './operatorMode';

describe('operator-mode navigation', () => {
  test('routes authenticated operators to the patient agent and signed-out visitors to the landing page', () => {
    expect(getOperatorHomePath(true)).toBe('/agent');
    expect(getOperatorHomePath(false)).toBe('/');
  });

  test('redirects every retired practitioner-owned list and calendar route', () => {
    expect(LEGACY_PROVIDER_PATHS).toStrictEqual([
      '/Schedule',
      '/Schedule/:id',
      '/Appointment/upcoming',
      '/Appointment/past',
    ]);
  });

  test('exposes only operator-facing navigation', () => {
    const menus = getOperatorMenus();
    const links = menus.flatMap((menu) => menu.links.map(({ label, href }) => ({ label, href })));

    expect(links).toStrictEqual([
      { label: 'Patients', href: '/Patient' },
      { label: 'Upload Core ValueSets', href: '/upload/core' },
      { label: 'New Request', href: '/agent' },
      { label: 'Doctor Desk', href: '/desk' },
    ]);
  });
});
