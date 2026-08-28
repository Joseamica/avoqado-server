/**
 * Codex 3ª auditoría: un retiro que viene de la cola offline de un aparato llega cuando SU caja ya cerró.
 * Rechazarlo perdía dinero real; cargarlo a la caja abierta de hoy lo atribuía mal. Ahora: con `sessionId`
 * se acepta sobre ESA caja (cerrada), bajo candado, recalculando el overShort firmado y dejando bitácora.
 */
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
import { payOut } from '@/services/mobile/cash-drawer.mobile.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).$transaction = jest.fn((fn: any) => fn(prismaMock))
  ;(prismaMock as any).staff = { findUnique: jest.fn().mockResolvedValue({ firstName: 'Ana', lastName: 'M' }) }
})

it('🔴 retiro tardío sobre una caja CERRADA: se acepta sobre ESA caja, recalcula overShort y deja bitácora ADJUSTED_AFTER_CLOSE', async () => {
  const update = jest.fn().mockResolvedValue({})
  ;(prismaMock as any).cashDrawerSession = {
    findFirst: jest.fn().mockResolvedValue({ id: 's-cerrada', status: 'CLOSED' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ actualAmount: 250, overShort: 50, startingAmount: 300, events: [{ type: 'OPEN', amount: 300 }, { type: 'PAY_OUT', amount: 50 }] }),
    update,
  }
  const stored = { id: 'e-1', sessionId: 's-cerrada', venueId: VENUE, type: 'PAY_OUT', amount: 50, staffId: 'st', staffName: 'Ana', note: null, createdAt: new Date(), localId: 'loc-1', orderId: null }
  ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn().mockResolvedValue(stored), create: jest.fn() }
  const r = await payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 50, note: null, localId: 'loc-1', sessionId: 's-cerrada' })
  expect(r.created).toBe(true)
  // contado 250 − esperado (300 − 50 = 250) = 0: la diferencia firmada de +50 se corrige a 0
  expect(Number(update.mock.calls[0][0].data.overShort)).toBe(0)
  expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CASH_DRAWER_ADJUSTED_AFTER_CLOSE', entityId: 's-cerrada', data: expect.objectContaining({ overShortBefore: 50, overShortAfter: 0, source: 'MOBILE_OFFLINE_REPLAY' }) }))
})

it('🔴 con sessionId de una caja que NO es de este venue → 404 y nada se escribe', async () => {
  ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn() }
  ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn(), create: jest.fn(), findFirst: jest.fn() }
  await expect(payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 50, note: null, sessionId: 's-ajena' })).rejects.toMatchObject({ statusCode: 404 })
  expect((prismaMock as any).cashDrawerEvent.createMany).not.toHaveBeenCalled()
})

it('el reintento del MISMO retiro tardío (mismo localId) no duplica ni recalcula dos veces', async () => {
  const update = jest.fn()
  ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue({ id: 's-cerrada', status: 'CLOSED' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn(), update }
  const stored = { id: 'e-1', sessionId: 's-cerrada', venueId: VENUE, type: 'PAY_OUT', amount: 50, staffId: 'st', staffName: 'Ana', note: null, createdAt: new Date(), localId: 'loc-1', orderId: null }
  ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 0 }), findFirst: jest.fn().mockResolvedValue(stored), create: jest.fn() }
  const r = await payOut({ venueId: VENUE, staffId: 'st', staffName: 'Ana', amount: 50, note: null, localId: 'loc-1', sessionId: 's-cerrada' })
  expect(r.created).toBe(false)
  expect(update).not.toHaveBeenCalled()
})
