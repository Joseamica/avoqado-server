jest.mock('@/services/access/basePlan.service', () => ({
  __esModule: true,
  venueHasFeatureAccess: jest.fn(),
}))
jest.mock('@/services/dashboard/reservationSettings.service', () => ({
  __esModule: true,
  getReservationSettings: jest.fn(),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

import { resolveBookingAccess, computeBookingAccess } from '@/services/public/bookingAccess.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'
import logger from '@/config/logger'

/**
 * Fase 0.B — `bookingAccess`: el widget/kiosco pinta el estado de "¿puedo reservar?" al
 * iniciar sesión en vez de descubrirlo por un 403 al final. COMPONE tres cosas, en este
 * orden: plan (RESERVATIONS · PRO) → reservas públicas prendidas → aprobación del cliente.
 * `blockedBy` es el PRIMERO que falla.
 */
describe('resolveBookingAccess (pura)', () => {
  it('todo en orden → canCreateReservation=true, sin blockedBy', () => {
    expect(resolveBookingAccess({ hasPlan: true, publicBookingEnabled: true, approvalStatus: 'APPROVED' })).toEqual({
      status: 'APPROVED',
      canCreateReservation: true,
    })
  })

  it('sin plan → blockedBy PLAN (aunque lo demás esté bien)', () => {
    expect(resolveBookingAccess({ hasPlan: false, publicBookingEnabled: true, approvalStatus: 'APPROVED' })).toEqual({
      status: 'APPROVED',
      canCreateReservation: false,
      blockedBy: 'PLAN',
    })
  })

  it('con plan pero reservas públicas apagadas → PUBLIC_BOOKING_OFF', () => {
    expect(resolveBookingAccess({ hasPlan: true, publicBookingEnabled: false, approvalStatus: 'APPROVED' })).toEqual({
      status: 'APPROVED',
      canCreateReservation: false,
      blockedBy: 'PUBLIC_BOOKING_OFF',
    })
  })

  it('plan y público ok pero cliente PENDING → APPROVAL, y status refleja PENDING', () => {
    expect(resolveBookingAccess({ hasPlan: true, publicBookingEnabled: true, approvalStatus: 'PENDING' })).toEqual({
      status: 'PENDING',
      canCreateReservation: false,
      blockedBy: 'APPROVAL',
    })
  })

  it('orden: si fallan varios, gana el primero (PLAN antes que PUBLIC_BOOKING_OFF antes que APPROVAL)', () => {
    expect(resolveBookingAccess({ hasPlan: false, publicBookingEnabled: false, approvalStatus: 'REJECTED' }).blockedBy).toBe('PLAN')
    expect(resolveBookingAccess({ hasPlan: true, publicBookingEnabled: false, approvalStatus: 'REJECTED' }).blockedBy).toBe(
      'PUBLIC_BOOKING_OFF',
    )
  })
})

describe('computeBookingAccess (compuesta)', () => {
  beforeEach(() => jest.clearAllMocks())

  it('consulta RESERVATIONS del venue y publicBooking.enabled de los settings', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    ;(getReservationSettings as jest.Mock).mockResolvedValue({ publicBooking: { enabled: true } })

    const r = await computeBookingAccess('venue-1')

    expect(venueHasFeatureAccess).toHaveBeenCalledWith('venue-1', 'RESERVATIONS')
    expect(getReservationSettings).toHaveBeenCalledWith('venue-1')
    expect(r).toEqual({ status: 'APPROVED', canCreateReservation: true })
  })

  it('Fase 0: el status es siempre APPROVED (la aprobación por cliente llega en Fase 1)', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    ;(getReservationSettings as jest.Mock).mockResolvedValue({ publicBooking: { enabled: false } })

    const r = await computeBookingAccess('venue-1')

    expect(r).toEqual({ status: 'APPROVED', canCreateReservation: false, blockedBy: 'PUBLIC_BOOKING_OFF' })
  })

  it('publicBooking ausente en settings → se trata como prendido (mismo default que el controller)', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    ;(getReservationSettings as jest.Mock).mockResolvedValue({})

    const r = await computeBookingAccess('venue-1')
    expect(r.canCreateReservation).toBe(true)
  })

  it('si la consulta de plan truena → fail-open como el gate (hasPlan=true) y se loguea', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockRejectedValue(new Error('db down'))
    ;(getReservationSettings as jest.Mock).mockResolvedValue({ publicBooking: { enabled: true } })

    const r = await computeBookingAccess('venue-1')

    expect(r.canCreateReservation).toBe(true)
    expect((logger as any).error).toHaveBeenCalledWith(
      expect.stringContaining('bookingAccess'),
      expect.objectContaining({ venueId: 'venue-1' }),
    )
  })
})
