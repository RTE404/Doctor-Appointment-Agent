// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { AppShell, ErrorBoundary, Loading, Logo, useMedplum, useMedplumProfile } from '@medplum/react';
import { Suspense } from 'react';
import type { JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppointmentDetailPage } from './pages/AppointmentDetailPage';
import { LandingPage } from './pages/LandingPage';
import { PatientPage } from './pages/PatientPage';
import { ResourcePage } from './pages/ResourcePage';
import { SearchPage } from './pages/SearchPage';
import { LEGACY_PROVIDER_PATHS, getOperatorHomePath, getOperatorMenus } from './operatorMode';
import { PatientPickerPage } from './pages/agent/PatientPickerPage';
import { PatientHistoryPage } from './pages/agent/PatientHistoryPage';
import { BookingConfirmationPage } from './pages/agent/BookingConfirmationPage';
import { DoctorLookupPage } from './pages/desk/DoctorLookupPage';
import { DoctorQueuePage } from './pages/desk/DoctorQueuePage';
import { PatientAgentChatPage } from './pages/desk/PatientAgentChatPage';

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
