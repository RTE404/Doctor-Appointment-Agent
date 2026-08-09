// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Loader, Stack, Title } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import { Document, useMedplum } from '@medplum/react';
import type { Appointment, Bundle } from '@medplum/fhirtypes';
import dayjs from 'dayjs';
import type { JSX } from 'react';
import { useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SlotGrid } from '../../components/agent/SlotGrid';
import type { SlotOption } from '../../components/agent/SlotGrid';
import { BookingContext } from '../../booking.context';
import { executeAction } from '../../api/executeAction';
import type { BookInput, BookResult } from '../../bots/agent/agent-book-appointment';
import type { EnsureDoctorInput, EnsureDoctorResult } from '../../bots/agent/agent-ensure-doctor';

export function SlotPickerPage(): JSX.Element {
  const { patientId, npi } = useParams();
  const medplum = useMedplum();
  const navigate = useNavigate();
  const { booking } = useContext(BookingContext);
  const [slots, setSlots] = useState<SlotOption[]>();
  const [provisioned, setProvisioned] = useState<EnsureDoctorResult>();
  const [error, setError] = useState<string>();
  const [bookingInFlight, setBookingInFlight] = useState(false);

  const fetchSlots = useCallback(async (): Promise<void> => {
    if (!booking.intent) {
      Promise.resolve(navigate(`/agent/${patientId}`)).catch(console.error);
      return;
    }
    setSlots(undefined);
    setError(undefined);
    try {
      const input: EnsureDoctorInput = { npi: npi as string };
      const provisioned = await executeAction<EnsureDoctorInput, EnsureDoctorResult>(medplum, 'agent-ensure-doctor', input);
      setProvisioned(provisioned);
      const healthcareServiceId = provisioned.healthcareServiceId;
      const start = dayjs().add(1, 'day').startOf('day').toISOString();
      const end = dayjs().add(15, 'day').endOf('day').toISOString();

      // $find's response is a BARE Bundle of proposed Appointments (each
      // with a contained Slot) — confirmed directly in Medplum's
      // buildOutputParameters: an operation with exactly one 'return'
      // output parameter (both $find and $book declare this) bypasses the
      // Parameters wrapper and sends the Bundle directly as the HTTP
      // response body. Medplum's own appointment-find.md doc is stale and
      // describes the wrong, Parameters-wrapped shape — don't trust it;
      // the official example client code and the sibling
      // appointment-book.md doc both confirm the bare-Bundle shape.
      const findUrl = medplum.fhirUrl('Appointment', '$find');
      findUrl.searchParams.set('service-type-reference', `HealthcareService/${healthcareServiceId}`);
      findUrl.searchParams.set('schedule', `Schedule/${provisioned.scheduleId}`);
      findUrl.searchParams.set('start', start);
      findUrl.searchParams.set('end', end);
      findUrl.searchParams.set('_count', '100');
      const bundle: Bundle<Appointment> = await medplum.get(findUrl);
      const proposedAppointments = (bundle.entry ?? []).map((e) => e.resource as Appointment).filter(Boolean);

      setSlots(
        proposedAppointments.map((appointment) => ({
          start: appointment.start as string,
          end: appointment.end as string,
        }))
      );
    } catch (err) {
      setError(normalizeErrorString(err));
    }
  }, [medplum, patientId, npi, booking.intent, navigate]);

  useEffect(() => {
    fetchSlots().catch(console.error);
  }, [fetchSlots]);

  async function handlePick(slot: SlotOption): Promise<void> {
    if (!booking.intent || !booking.summaryCommunicationId || !provisioned) return;
    setBookingInFlight(true);
    setError(undefined);
    try {
      const input: BookInput = {
        patientId: patientId as string,
        practitionerId: provisioned.practitionerId,
        scheduleId: provisioned.scheduleId,
        start: slot.start,
        end: slot.end,
        summaryCommunicationId: booking.summaryCommunicationId,
      };
      const result = await executeAction<BookInput, BookResult>(medplum, 'agent-book-appointment', input);
      if (!result.ok) {
        setError('That slot was just taken — please pick another.');
        await fetchSlots(); // actually re-fetch, not just clear-and-hope
        return;
      }
      Promise.resolve(navigate(`/agent/${patientId}/confirmed/${result.appointment.id}`)).catch(console.error);
    } catch (err) {
      setError(normalizeErrorString(err));
    } finally {
      setBookingInFlight(false);
    }
  }

  return (
    <Document width={800}>
      <Stack>
        <Title order={1}>Available Slots</Title>
        {error && <Alert color="red">{error}</Alert>}
        {!slots && !error && <Loader />}
        {slots?.length === 0 && <Alert color="yellow">No slots available in the next 15 days.</Alert>}
        {slots && <SlotGrid slots={slots} onPick={handlePick} disabled={bookingInFlight} />}
      </Stack>
    </Document>
  );
}
