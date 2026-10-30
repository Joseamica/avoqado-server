/**
 * P1 de la auditoría de Codex (27-ago, fase 5): la venta tardía entraba a una caja YA CERRADA.
 *
 * Carrera: (1) la venta encuentra la sesión OPEN · (2) el cierre lee los eventos · (3) el cierre
 * marca CLOSED y firma el overShort · (4) la venta inserta CASH_SALE con el id que leyó en (1).
 * El `overShort` firmado no incluye esa venta y la PAX puede enseñar "esperado 1,100 / contado
 * 1,100 / faltante 100" a la vez.
 *
 * Arreglo: el insert va en una transacción que PRIMERO toca la fila de la sesión con
 * `status='OPEN'` (UPDATE = candado de fila). Si el cierre ya la marcó CLOSED, el UPDATE espera
 * y al re-evaluar no hay fila → no se inserta y el helper devuelve `DRAWER_CLOSED` (fail-open:
 * el cobro ya ocurrió; la caja no lo bloquea). Con `targetSessionId` (barrido de la fase 3
 * reparando una ventana cerrada) el candado NO exige OPEN.
 */
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
import { postCashSaleToDrawer, postCashRefundToDrawer } from '@/services/shared/cashDrawerPosting'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = 'venue-1'
const venta = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  paymentId: 'p-1',
  method: 'CASH',
  status: 'COMPLETED',
  type: 'REGULAR',
  amount: 100,
  tipAmount: 0,
  staffId: 'staff-1',
  staffName: 'Cajero',
  orderId: 'o-1',
  ...over,
})

describe('candado de sesión al sumar al cajón (P1 venta tardía)', () => {
  let updateMany: jest.Mock, createMany: jest.Mock, findMany: jest.Mock
  beforeEach(() => {
    jest.clearAllMocks()
    updateMany = jest.fn().mockResolvedValue({ count: 1 })
    createMany = jest.fn().mockResolvedValue({ count: 1 })
    findMany = jest.fn().mockResolvedValue([])
    ;(prismaMock as any).cashDrawerSession = {
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue({ id: 's-1' }),
      updateMany,
      findUnique: jest.fn().mockResolvedValue(null),
    }
    ;(prismaMock as any).cashDrawerEvent = { createMany, findMany }
    ;(prismaMock as any).$transaction = jest.fn((fn: any) => fn(prismaMock))
  })

  it('🔴 toca la fila con status=OPEN DENTRO de la transacción y sólo entonces inserta', async () => {
    const out = await postCashSaleToDrawer(venta())
    expect(out).toBe('POSTED')
    expect((prismaMock as any).$transaction).toHaveBeenCalledTimes(1)
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's-1', venueId: VENUE, status: 'OPEN' } }))
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(createMany.mock.invocationCallOrder[0])
  })

  it('🔴 si el cierre ganó la carrera (la fila ya no está OPEN) NO inserta nada y devuelve DRAWER_CLOSED', async () => {
    updateMany.mockResolvedValue({ count: 0 })
    const out = await postCashSaleToDrawer(venta())
    expect(out).toBe('DRAWER_CLOSED')
    expect(createMany).not.toHaveBeenCalled()
  })

  it('el barrido que repara una ventana CERRADA (targetSessionId) no exige OPEN', async () => {
    const out = await postCashSaleToDrawer(venta({ targetSessionId: 's-cerrada' }))
    expect(out).toBe('POSTED')
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's-1', venueId: VENUE } }))
  })

  it('Rappi 2b (Codex código de apps r3): la venta y lo cobrado por cuenta de Rappi entran en UNA transacción, o ninguno', async () => {
    const out = await postCashSaleToDrawer(venta({ amount: 175, tipAmount: 20, thirdPartyCashAmount: 10, orderNumber: '881655210' }))
    expect(out).toBe('POSTED')
    expect((prismaMock as any).$transaction).toHaveBeenCalledTimes(1)
    expect(createMany).toHaveBeenCalledTimes(1)
    const filas = createMany.mock.calls[0][0].data
    expect(filas.map((f: any) => [f.type, Number(f.amount), f.localId])).toEqual([
      ['PAY_IN', 10, 'srv-third-party:p-1'],
      ['CASH_SALE', 195, 'srv-cash-sale:p-1'],
    ])
  })

  it('Rappi 2b (Codex código de apps r4): un replay parcial sólo agrega lo que falta', async () => {
    findMany.mockResolvedValue([{ localId: 'srv-third-party:p-1' }])
    const out = await postCashSaleToDrawer(venta({ amount: 175, tipAmount: 20, thirdPartyCashAmount: 10, orderNumber: '881655210' }))
    expect(out).toBe('POSTED')
    expect(createMany.mock.calls[0][0].data.map((f: any) => f.type)).toEqual(['CASH_SALE'])
  })

  it('Rappi 2b: si las dos ya estaban, no agrega nada y es ALREADY_POSTED', async () => {
    findMany.mockResolvedValue([{ localId: 'srv-third-party:p-1' }, { localId: 'srv-cash-sale:p-1' }])
    const out = await postCashSaleToDrawer(venta({ amount: 175, tipAmount: 20, thirdPartyCashAmount: 10, orderNumber: '881655210' }))
    expect(out).toBe('ALREADY_POSTED')
    expect(createMany).not.toHaveBeenCalled()
  })

  it('una venta normal no consulta nada extra', async () => {
    await postCashSaleToDrawer(venta())
    expect(findMany).not.toHaveBeenCalled()
  })

  it('Rappi 2b: si la caja se cerró, no entra ni la venta ni lo de Rappi', async () => {
    updateMany.mockResolvedValue({ count: 0 })
    const out = await postCashSaleToDrawer(venta({ amount: 175, tipAmount: 20, thirdPartyCashAmount: 10, orderNumber: '881655210' }))
    expect(out).toBe('DRAWER_CLOSED')
    expect(createMany).not.toHaveBeenCalled()
  })

  it('el reembolso (PAY_OUT) usa el mismo candado', async () => {
    updateMany.mockResolvedValue({ count: 0 })
    const out = await postCashRefundToDrawer({
      venueId: VENUE,
      refundPaymentId: 'r-1',
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REFUND',
      amount: -50,
      staffId: 'staff-1',
      staffName: 'Cajero',
      reason: 'x',
    } as any)
    expect(out).toBe('DRAWER_CLOSED')
    expect(createMany).not.toHaveBeenCalled()
  })
})
