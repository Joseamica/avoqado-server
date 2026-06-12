/**
 * Live Demo — simulateReservation service (Avoqado Tour, journey "reserva")
 *
 * Mirrors liveDemo.simFastPayment.service.test.ts: session auth, the HARD
 * LIVE_DEMO venue check and the per-session cap run for real against the
 * global prisma mock. The dashboard createReservation service (transactional,
 * raw-SQL heavy) is mocked — what matters here is that the sim calls it with
 * the exact shape the calendar journey depends on (channel WEB, confirmed
 * guest, sim marker on internalNotes, next half-hour slot ≥1h away).
 */

import prisma from '@/utils/prismaClient'
import { simulateReservation, SIM_RESERVATION_NOTE_PREFIX, MAX_SIM_RESERVATIONS_PER_SESSION } from '@/services/liveDemo.service'
import { createReservation } from '@/services/dashboard/reservation.dashboard.service'
import { ForbiddenError, TooManyRequestsError, UnauthorizedError } from '@/errors/AppError'

jest.mock('@/services/dashboard/reservation.dashboard.service', () => ({
  createReservation: jest.fn(),
}))

const prismaMock = prisma as any
const mockedCreateReservation = createReservation as jest.Mock

const SESSION_ID = 'cookie-session-1'
const VENUE_ID = 'venue-live-demo-1'
const STAFF_ID = 'staff-demo-1'

function futureDate(hours = 2): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000)
}

function pastDate(hours = 2): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000)
}

function mockValidSession(expiresAt: Date = futureDate()) {
  prismaMock.liveDemoSession.findUnique.mockResolvedValue({
    id: 'lds-1',
    sessionId: SESSION_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    expiresAt,
  })
}

function mockHappyPathPrisma() {
  mockValidSession()
  prismaMock.venue.findUnique.mockResolvedValue({ status: 'LIVE_DEMO' })
  prismaMock.reservation.count.mockResolvedValue(0)
  prismaMock.liveDemoSession.update.mockResolvedValue({})
  mockedCreateReservation.mockResolvedValue({
    id: 'resv-sim-1',
    confirmationCode: 'RES-A3X7K2',
    status: 'CONFIRMED',
  })
}

describe('simulateReservation — live demo sim reservation service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('throws UnauthorizedError (401) when the session does not exist', async () => {
    prismaMock.liveDemoSession.findUnique.mockResolvedValue(null)

    await expect(simulateReservation('ghost-session')).rejects.toThrow(UnauthorizedError)
    expect(mockedCreateReservation).not.toHaveBeenCalled()
  })

  it('throws UnauthorizedError (401) when the session is expired', async () => {
    mockValidSession(pastDate())

    await expect(simulateReservation(SESSION_ID)).rejects.toThrow(UnauthorizedError)
    expect(mockedCreateReservation).not.toHaveBeenCalled()
  })

  it('throws ForbiddenError (403) when the session venue is NOT a LIVE_DEMO venue', async () => {
    mockValidSession()
    prismaMock.venue.findUnique.mockResolvedValue({ status: 'ACTIVE' })

    await expect(simulateReservation(SESSION_ID)).rejects.toThrow(ForbiddenError)
    expect(mockedCreateReservation).not.toHaveBeenCalled()
  })

  it('throws TooManyRequestsError (429) at the per-session sim cap', async () => {
    mockValidSession()
    prismaMock.venue.findUnique.mockResolvedValue({ status: 'LIVE_DEMO' })
    prismaMock.reservation.count.mockResolvedValue(MAX_SIM_RESERVATIONS_PER_SESSION)

    await expect(simulateReservation(SESSION_ID)).rejects.toThrow(TooManyRequestsError)
    expect(mockedCreateReservation).not.toHaveBeenCalled()
    // The cap only counts SIM-marked reservations — seeded data must not eat the cap
    expect(prismaMock.reservation.count).toHaveBeenCalledWith({
      where: {
        venueId: VENUE_ID,
        internalNotes: { startsWith: SIM_RESERVATION_NOTE_PREFIX },
      },
    })
  })

  it('creates the reservation with the journey contract (WEB channel, Sofía, sim marker, next slot ≥1h)', async () => {
    mockHappyPathPrisma()
    const before = Date.now()

    const result = await simulateReservation(SESSION_ID)

    expect(mockedCreateReservation).toHaveBeenCalledTimes(1)
    const [venueId, input] = mockedCreateReservation.mock.calls[0]
    expect(venueId).toBe(VENUE_ID)
    expect(input.channel).toBe('WEB')
    expect(input.guestName).toBe('Sofía Ramírez')
    expect(input.partySize).toBe(1)
    expect(input.duration).toBe(45)
    expect(input.internalNotes).toMatch(new RegExp(`^${SIM_RESERVATION_NOTE_PREFIX}-`))

    // startsAt: half-hour boundary, at least 1h away (within tolerance of the call)
    const startsAt: Date = input.startsAt
    expect(startsAt.getTime() % (30 * 60_000)).toBe(0)
    expect(startsAt.getTime()).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1)
    // endsAt = startsAt + 45min
    expect(input.endsAt.getTime() - startsAt.getTime()).toBe(45 * 60_000)

    // Result mapping + session keep-alive
    expect(result).toEqual({
      reservationId: 'resv-sim-1',
      confirmationCode: 'RES-A3X7K2',
      startsAt: startsAt.toISOString(),
    })
    expect(prismaMock.liveDemoSession.update).toHaveBeenCalled()
  })
})
