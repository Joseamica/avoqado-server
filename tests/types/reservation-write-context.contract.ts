import { createReservation } from '@/services/dashboard/reservation.dashboard.service'

const input = {
  startsAt: new Date('2026-03-01T14:00:00Z'),
  endsAt: new Date('2026-03-01T15:00:00Z'),
  duration: 60,
}

// @ts-expect-error Reservation writes must always declare their non-persisted origin.
void createReservation('venue-1', input)
