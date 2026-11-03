/**
 * Pedidos en línea fase 2, clientes (S2, Codex plan r1 #1): «Cuentas abiertas» de ANDROID/WINDOWS/iOS no lista una cuenta cuya
 * tarjeta en línea está apartada sin cobrar. Si la listara, la cajera podría entrar al cobro genérico y, sin red, encolar efectivo
 * que el cliente ya pagó con tarjeta (el 409 del servidor llega tarde, al sincronizar). Cubre también a las apps publicadas.
 * Ya cobrada (`CAPTURED`) la cuenta está PAID y sale como siempre. La semántica real en Postgres la prueba
 * `tests/integration/online-ordering/card.integration.test.ts` («S2 …»).
 */
import { prismaMock } from '../../../__helpers__/setup'
import { listOrders } from '@/services/mobile/order.mobile.service'

const FILTRO_TARJETA_SIN_COBRAR = {
  NOT: { onlineOrder: { is: { paymentMode: 'CARD_ONLINE', charge: { isNot: { status: 'CAPTURED' } } } } },
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (ops: any) => (Array.isArray(ops) ? Promise.all(ops) : ops(prismaMock)))
  prismaMock.order.findMany.mockResolvedValue([])
  prismaMock.order.count.mockResolvedValue(0)
})

describe('listOrders de las apps: pedidos en línea con tarjeta sin cobrar', () => {
  it.each([
    ['por omisión', {}],
    ['buscando por folio', { search: 'W12' }],
    ['sólo las sin pagar', { paymentStatus: 'PENDING,PARTIAL' }],
  ])('%s, el listado y su conteo excluyen la tarjeta apartada', async (_caso, extra) => {
    await listOrders('venue-1', { page: 1, pageSize: 20, ...extra })
    const where = (prismaMock.order.findMany as jest.Mock).mock.calls[0][0].where
    expect(where.AND).toEqual(expect.arrayContaining([FILTRO_TARJETA_SIN_COBRAR]))
    expect((prismaMock.order.count as jest.Mock).mock.calls[0][0].where).toBe(where)
  })
})
