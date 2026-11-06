/**
 * Tienda híbrida (R53): un folio (`requiresAcceptance = false`) no se junta ni se divide por ningún camino compartido (POS, TPV, panel,
 * cola sin red: todos pasan por estas tres funciones). Un pedido de «Mi equipo» (`requiresAcceptance = true`) sigue como hoy.
 */
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/shared/tableOrderLock', () => ({
  __esModule: true,
  lockTableOrderScope: jest.fn().mockResolvedValue({}),
}))

import {
  mergeOrdersInTransaction,
  splitOrderBySeatInTransaction,
  splitOrderItemsInTransaction,
} from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'

const V = 'venue-1'
const FOLIO = 'folio-1'
const OTRA = 'otra-1'
const MENSAJE = 'Este es un pedido en línea: se cobra en su lista de folios.'

/** Sólo `FOLIO` es un folio; la guarda de tarjeta (`paymentMode`) lee otra forma y no ve nada. */
function soloFolio(folioIds: string[]) {
  prismaMock.onlineOrder.findFirst.mockImplementation((async (args: any) => {
    const w = args.where
    if (w.requiresAcceptance === false) return w.orderId.in.some((id: string) => folioIds.includes(id)) ? { id: 'oo1' } : null
    return null
  }) as any)
}

const rechazo = { statusCode: 409, code: 'ONLINE_ORDER_FOLIO_NO_SE_JUNTA', message: MENSAJE }

describe('un folio no se junta ni se divide', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.$queryRaw.mockResolvedValue([])
    prismaMock.customer.findMany.mockResolvedValue([] as any)
    soloFolio([FOLIO])
  })

  it('juntar: el folio como ORIGEN (de folio a otra) ⇒ 409', async () => {
    await expect(mergeOrdersInTransaction(prismaMock, V, OTRA, FOLIO)).rejects.toMatchObject(rechazo)
    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('juntar: el folio como DESTINO (de otra al folio) ⇒ 409', async () => {
    await expect(mergeOrdersInTransaction(prismaMock, V, FOLIO, OTRA)).rejects.toMatchObject(rechazo)
    expect(prismaMock.orderItem.updateMany).not.toHaveBeenCalled()
  })

  it('dividir por producto ⇒ 409, sin crear la cuenta nueva', async () => {
    await expect(splitOrderItemsInTransaction(prismaMock, V, FOLIO, ['i1'], 's1')).rejects.toMatchObject(rechazo)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('dividir por asiento ⇒ 409, sin crear la cuenta nueva', async () => {
    await expect(splitOrderBySeatInTransaction(prismaMock, V, FOLIO, 's1')).rejects.toMatchObject(rechazo)
    expect(prismaMock.order.create).not.toHaveBeenCalled()
  })

  it('un pedido de «Mi equipo» (no es folio) no lo frena esta guarda', async () => {
    soloFolio([])
    await expect(mergeOrdersInTransaction(prismaMock, V, OTRA, FOLIO)).rejects.not.toMatchObject({ code: 'ONLINE_ORDER_FOLIO_NO_SE_JUNTA' })
  })
})
