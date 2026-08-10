// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { AppShell, ErrorBoundary, Loading, Logo, useMedplum, useMedplumProfile } from '@medplum/react';
import { Suspense, useState } from 'react';
import type { JSX } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AppointmentDetailPage } from './pages/AppointmentDetailPage';
import { LandingPage } from './pages/LandingPage';
import { PatientPage } from './pages/PatientPage';
import { ResourcePage } from './pages/ResourcePage';
import { SearchPage } from './pages/SearchPage';
import { SignInPage } from './pages/SignInPage';
import { UploadDataPage } from './pages/UploadDataPage';
import { BookingContext } from './booking.context';
import type { BookingState } from './booking.context';
import { LEGACY_PROVIDER_PATHS, getOperatorHomePath, getOperatorMenus } from './operatorMode';
import { PatientPickerPage } from './pages/agent/PatientPickerPage';
import { PatientHistoryPage } from './pages/agent/PatientHistoryPage';
import { DoctorResultsPage } from './pages/agent/DoctorResultsPage';
import { SlotPickerPage } from './pages/agent/SlotPickerPage';
import { BookingConfirmationPage } from './pages/agent/BookingConfirmationPage';
import { DoctorLookupPage } from './pages/desk/DoctorLookupPage';
import { DoctorQueuePage } from './pages/desk/DoctorQueuePage';
import { PatientAgentChatPage } from './pages/desk/PatientAgentChatPage';

export function App(): JSX.Element | null {
  const medplum = useMedplum();
  const profile = useMedplumProfile();
  const [booking, setBooking] = useState<BookingState>({});
  const operatorHomePath = getOperatorHomePath(Boolean(profile));

  if (medplum.isLoading()) {
    return <Loading />;
  }

  return (
    <AppShell logo={<Logo size={24} />} menus={getOperatorMenus()}>
      <BookingContext.Provider value={{ booking, setBooking }}>
        <ErrorBoundary>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={profile ? <Navigate to={operatorHomePath} replace /> : <LandingPage />} />
              <Route path="/signin" element={<SignInPage />} />
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
              <Route path="/upload/core" element={<UploadDataPage uploadType="core" />} />
              <Route path="/agent" element={<PatientPickerPage />} />
              <Route path="/agent/:patientId" element={<PatientHistoryPage />} />
              <Route path="/agent/:patientId/doctors" element={<DoctorResultsPage />} />
              <Route path="/agent/:patientId/doctors/:npi/slots" element={<SlotPickerPage />} />
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
      </BookingContext.Provider>
    </AppShell>
  );
}
