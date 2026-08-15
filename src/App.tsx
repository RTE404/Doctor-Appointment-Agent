// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { AppShell, ErrorBoundary, Loading, Logo, useMedplum, useMedplumProfile } from '@medplum/react';
import { Suspense, lazy } from 'react';
import type { JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { LandingPage } from './pages/LandingPage';
import { LEGACY_PROVIDER_PATHS, getOperatorHomePath, getOperatorMenus } from './operatorMode';

// Lazily loaded so the initial bundle a patient downloads to start chatting
// doesn't also carry the doctor desk and the generic FHIR admin pages.
const AppointmentDetailPage = lazy(() =>
  import('./pages/AppointmentDetailPage').then((m) => ({ default: m.AppointmentDetailPage }))
);
const PatientPage = lazy(() => import('./pages/PatientPage').then((m) => ({ default: m.PatientPage })));
const ResourcePage = lazy(() => import('./pages/ResourcePage').then((m) => ({ default: m.ResourcePage })));
const SearchPage = lazy(() => import('./pages/SearchPage').then((m) => ({ default: m.SearchPage })));
const PatientPickerPage = lazy(() =>
  import('./pages/agent/PatientPickerPage').then((m) => ({ default: m.PatientPickerPage }))
);
const PatientHistoryPage = lazy(() =>
  import('./pages/agent/PatientHistoryPage').then((m) => ({ default: m.PatientHistoryPage }))
);
const BookingConfirmationPage = lazy(() =>
  import('./pages/agent/BookingConfirmationPage').then((m) => ({ default: m.BookingConfirmationPage }))
);
const DoctorLookupPage = lazy(() =>
  import('./pages/desk/DoctorLookupPage').then((m) => ({ default: m.DoctorLookupPage }))
);
const DoctorQueuePage = lazy(() =>
  import('./pages/desk/DoctorQueuePage').then((m) => ({ default: m.DoctorQueuePage }))
);
const PatientAgentChatPage = lazy(() =>
  import('./pages/desk/PatientAgentChatPage').then((m) => ({ default: m.PatientAgentChatPage }))
);

export function App(): JSX.Element | null {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const operatorHomePath = getOperatorHomePath(Boolean(profile));

  if (medplum.isLoading()) {
    return <Loading />;
  }

  if (!profile) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return (
    <AppShell logo={<Logo size={24} />} menus={getOperatorMenus()}>
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Navigate to={operatorHomePath} replace />} />
            <Route path="/signin" element={<Navigate to={operatorHomePath} replace />} />
            {LEGACY_PROVIDER_PATHS.map((path) => (
              <Route key={path} path={path} element={<Navigate to={operatorHomePath} replace />} />
            ))}
            <Route path="/Patient/:id" element={<PatientPage />}>
              <Route index element={<PatientPage />} />
              <Route path="*" element={<PatientPage />} />
            </Route>
            <Route path="/Appointment/:id" element={<AppointmentDetailPage />}>
              <Route index element={<AppointmentDetailPage />} />
              <Route path="*" element={<AppointmentDetailPage />} />
            </Route>
            <Route path="/upload/core" element={<Navigate to={operatorHomePath} replace />} />
            <Route path="/agent" element={<PatientPickerPage />} />
            <Route path="/agent/:patientId" element={<PatientHistoryPage />} />
            <Route path="/agent/:patientId/confirmed/:apptId" element={<BookingConfirmationPage />} />
            <Route path="/desk" element={<DoctorLookupPage />} />
            <Route path="/desk/:npi" element={<DoctorQueuePage />} />
            <Route path="/desk/:npi/patients/:patientId" element={<PatientAgentChatPage />} />
            <Route path="/:resourceType" element={<SearchPage />} />
            <Route path="/:resourceType/:id" element={<ResourcePage />}>
              <Route index element={<ResourcePage />} />
              <Route path="*" element={<ResourcePage />} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}
