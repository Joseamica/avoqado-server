/**
 * P1 (Codex, 2ª auditoría): el barrido (fase 3) repone ventas dentro de una caja YA CERRADA y contada;
 * el esperado subía y el `overShort` firmado se quedaba viejo. Ahora se recalcula bajo el mismo candado.
 */
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))
import { postCashSaleToDrawer } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

const venta = { venueId: 'v', paymentId: 'p-1', method: 'CASH', status: 'COMPLETED', type: 'REGULAR', amount: 100, tipAmount: 0, staffId: 's', staffName: 'C', orderId: 'o', targetSessionId: 's-cerrada' }

it('🔴 al reponer en una caja CERRADA y contada, el overShort se recalcula (contado 1,000 − esperado 1,100 = −100)', async () => {
  const update = jest.fn().mockResolvedValue({})
  ;(prismaMock as any).cashDrawerSession = { update: jest.fn().mockResolvedValue({}),
    findFirst: jest.fn().mockResolvedValue({ id: 's-cerrada' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findUnique: jest.fn().mockResolvedValue({ status: 'CLOSED', actualAmount: 1000, startingAmount: 1000, events: [{ type: 'OPEN', amount: 1000 }, { type: 'CASH_SALE', amount: 100 }] }),
    update,
  }
  ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
  ;(prismaMock as any).$transaction = jest.fn((fn: any) => fn(prismaMock))
  expect(await postCashSaleToDrawer(venta as any)).toBe('POSTED')
  expect(Number(update.mock.calls[0][0].data.overShort)).toBe(-100)
})

it('en una caja ABIERTA no se toca el overShort (se firma al cerrar)', async () => {
  const update = jest.fn()
  ;(prismaMock as any).cashDrawerSession = { update: jest.fn().mockResolvedValue({}), findFirst: jest.fn().mockResolvedValue({ id: 's-1' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn(), update }
  ;(prismaMock as any).cashDrawerEvent = { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
  ;(prismaMock as any).$transaction = jest.fn((fn: any) => fn(prismaMock))
  expect(await postCashSaleToDrawer({ ...venta, targetSessionId: undefined } as any)).toBe('POSTED')
  expect(update).not.toHaveBeenCalled()
})
