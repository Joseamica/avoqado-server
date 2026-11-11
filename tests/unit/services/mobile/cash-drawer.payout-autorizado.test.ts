/**
 * Retiro autorizado por un gerente: la bitácora y la respuesta dicen QUIÉN autorizó.
 * `authorizedBy` es aditivo: sin autorizador es `null` y la bitácora queda como siempre.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { payIn, payOut } from '@/services/mobile/cash-drawer.mobile.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const LLAVE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const fila = {
  id: 'evt-1',
  sessionId: 'session-1',
  venueId: VENUE,
  type: 'PAY_OUT',
  amount: 80,
  note: null,
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: null,
  localId: LLAVE,
  createdAt: new Date('2026-11-10T10:00:00Z'),
}
const retiro = (over: Record<string, any> = {}) => ({ venueId: VENUE, staffId: 'staff-1', staffName: 'Cajero', amount: 80, localId: LLAVE, ...over }) as any

const montar = (count: number) => {
  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue({ id: 'session-1', status: 'OPEN' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  }
  ;(prismaMock as any).cashDrawerEvent = {
    createMany: jest.fn().mockResolvedValue({ count }),
    findFirst: jest.fn().mockResolvedValue(fila),
  }
  ;(prismaMock as any).staffVenue = {
    findUnique: jest.fn().mockResolvedValue({ staff: { firstName: 'Daniel', lastName: 'Pérez' } }),
  }
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('payOut con autorizador', () => {
  it('con autorizador, la bitácora CASH_DRAWER_PAY_OUT lo guarda', async () => {
    montar(1)
    await payOut(retiro({ authorizedByStaffVenueId: 'sv-1' }))
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CASH_DRAWER_PAY_OUT',
        data: expect.objectContaining({ authorizedByStaffVenueId: 'sv-1', authorizedByName: 'Daniel Pérez' }),
      }),
    )
  })

  it('con autorizador, el resultado trae authorizedBy', async () => {
    montar(1)
    const r = await payOut(retiro({ authorizedByStaffVenueId: 'sv-1' }))
    expect(r.authorizedBy).toEqual({ id: 'sv-1', name: 'Daniel Pérez' })
  })

  it('sin autorizador, authorizedBy null y la bitácora sin esos campos', async () => {
    montar(1)
    const r = await payOut(retiro())
    expect(r.authorizedBy).toBeNull()
    const data = (logAction as jest.Mock).mock.calls[0][0].data
    expect(data).not.toHaveProperty('authorizedByStaffVenueId')
    expect(data).not.toHaveProperty('authorizedByName')
    expect((prismaMock as any).staffVenue.findUnique).not.toHaveBeenCalled()
  })

  it('un reintento con la misma llave y el mismo autorizador devuelve authorizedBy sin crear fila ni bitácora', async () => {
    montar(0)
    const r = await payOut(retiro({ authorizedByStaffVenueId: 'sv-1' }))
    expect(r.created).toBe(false)
    expect(r.authorizedBy).toEqual({ id: 'sv-1', name: 'Daniel Pérez' })
    expect(logAction).not.toHaveBeenCalled()
  })

  it('pay-in no cambia', async () => {
    montar(1)
    const r = await payIn(retiro({ authorizedByStaffVenueId: 'sv-1' }))
    expect(r.authorizedBy).toBeNull()
    const data = (logAction as jest.Mock).mock.calls[0][0].data
    expect(data).not.toHaveProperty('authorizedByStaffVenueId')
  })
})
