import { IconMessageCircle2, IconStethoscope, IconUser } from '@tabler/icons-react';
import type { JSX } from 'react';

export const LEGACY_PROVIDER_PATHS = [
  '/Schedule',
  '/Schedule/:id',
  '/Appointment/upcoming',
  '/Appointment/past',
] as const;

export function getOperatorHomePath(authenticated: boolean): '/agent' | '/' {
  return authenticated ? '/agent' : '/';
}

export function getOperatorMenus(): {
  title: string;
  links: { icon: JSX.Element; label: string; href: string }[];
}[] {
  return [
    {
      title: 'Charts',
      links: [{ icon: <IconUser />, label: 'Patients', href: '/Patient' }],
    },
    {
      title: 'Patient Agent',
      links: [{ icon: <IconStethoscope />, label: 'New Request', href: '/agent' }],
    },
    {
      title: 'Doctor Desk',
      links: [{ icon: <IconMessageCircle2 />, label: 'Doctor Desk', href: '/desk' }],
    },
  ];
}
