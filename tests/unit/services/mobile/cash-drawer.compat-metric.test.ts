/**
 * Fase 3 · "sin código muerto que no dependa del founder".
 *
 * `syncEvents` descarta el `CASH_SALE` que empujan las apps YA DESPLEGADAS (el servidor es dueño
 * del movimiento desde el 16-ago). Ese descarte es compatibilidad hacia atrás y tiene que poder
 * retirarse algún día — pero NO por "ya están todos actualizados" (gate manual), sino por dato:
 * el registro `CASH_DRAWER_SYNC` de la bitácora lleva `droppedCashSales` y la versión de la app.
 * Cuando una consulta muestre N días con 0 descartes, el descarte se retira. Esta prueba fija
 * el contrato de esa métrica.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { logAction } from '@/services/dashboard/activity-log.service'
import { syncEvents } from '@/services/mobile/cash-drawer.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const sesion = { id: 'session-1', venueId: VENUE, status: 'OPEN' }

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock as any).cashDrawerSession = { findFirst: jest.fn().mockResolvedValue(sesion) }
  ;(prismaMock as any).cashDrawerEvent = {
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation(async (a: any) => ({ id: 'evt-1', ...a.data, createdAt: new Date() })),
  }
  ;(prismaMock as any).$transaction = jest.fn().mockImplementation(async (fn: any) => fn(prismaMock))
})

const ev = (type: string, amount: number) => ({ type, amount, staffId: 'staff-1', staffName: 'Cajero' })

describe('métrica de compatibilidad en CASH_DRAWER_SYNC', () => {
  it('🔴 registra cuántos CASH_SALE descartó y la versión de la app que los mandó', async () => {
    await syncEvents(VENUE, [ev('CASH_SALE', 100), ev('CASH_SALE', 50), ev('PAY_IN', 20)], '2.31.0')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CASH_DRAWER_SYNC', data: expect.objectContaining({ droppedCashSales: 2, appVersion: '2.31.0' }) }),
    )
  })

  it('una app actualizada que no empuja CASH_SALE registra 0 — es lo que se mide para retirar el descarte', async () => {
    await syncEvents(VENUE, [ev('PAY_OUT', 30)], '2.40.0')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ droppedCashSales: 0, appVersion: '2.40.0' }) }),
    )
  })

  it('sin header de versión, appVersion queda null (app muy vieja): también cuenta', async () => {
    await syncEvents(VENUE, [ev('CASH_SALE', 100), ev('PAY_IN', 5)])
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ droppedCashSales: 1, appVersion: null }) }),
    )
  })
})
