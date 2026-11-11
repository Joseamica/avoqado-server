/**
 * D25 (Codex r2 #1): mientras se anula A, otra caja puede estar moviendo las mismas comandas (unir B en D). Cada escritura exige el
 * dueño y la comanda que se leyeron; lo que otra ya se llevó no se pisa, y si nunca se puede avanzar la operación falla en vez de dejar
 * que la anulación borre comida ajena. Los casos normales (y contra Postgres) están en kds-dueno-al-mover.integration.test.ts.
 */
import { prismaMock } from '../../../__helpers__/setup'
import { ponerComandasConSuCuenta } from '@/services/kds/kitchenTicketAuthoring.service'
import { esErrorTransitorio } from '@/services/shared/erroresTransitorios'

const fila = { id: 'fila-taco', kdsOrderId: 'comanda-a', cabecera: 'cuenta-a', dueno: 'cuenta-b' }

/** Las lecturas de filas salen de `lecturas` (la última se repite); el candado de comandas (`pg_advisory_xact_lock`) siempre pasa. */
const sql = (q: unknown) => (Array.isArray(q) ? q.join('?') : ((q as { strings?: string[] })?.strings ?? []).join('?'))
function lecturasDeFilas(...lecturas: unknown[][]) {
  const leidas: string[] = []
  prismaMock.$queryRaw.mockImplementation((async (q: unknown) => {
    if (sql(q).includes('pg_advisory_xact_lock')) return []
    leidas.push(sql(q))
    return lecturas[Math.min(leidas.length - 1, lecturas.length - 1)]
  }) as any)
  return leidas
}
const comanda = (items: number) => ({
  id: 'comanda-a',
  orderId: 'cuenta-a',
  orderType: 'DINE_IN',
  status: 'NEW',
  startedAt: null,
  preparationVersion: 0,
  printStationId: 'cocina',
  fallbackPrintedAt: null,
  printedAt: null,
  customerName: null,
  customerContact: null,
  createdAt: new Date('2026-11-10T18:00:00Z'),
  _count: { items },
})

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.order.findMany.mockResolvedValue([{ id: 'cuenta-b', orderNumber: 'B-1' }] as any)
  prismaMock.kdsOrder.create.mockResolvedValue({ id: 'comanda-nueva' } as any)
  prismaMock.kdsOrder.deleteMany.mockResolvedValue({ count: 0 })
})

describe('ponerComandasConSuCuenta — otra caja moviendo lo mismo a la vez', () => {
  it('si otra cuenta ya se llevó la pieza, no la pisa y borra el folio nuevo que sobró', async () => {
    lecturasDeFilas([fila], [fila], [])
    prismaMock.kdsOrder.findMany.mockResolvedValue([comanda(2)] as any)
    prismaMock.kdsOrderItem.updateMany.mockResolvedValue({ count: 0 })

    expect(await ponerComandasConSuCuenta(prismaMock as any, 'venue-1', 'cuenta-a')).toEqual([])

    expect(prismaMock.kdsOrderItem.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['fila-taco'] }, kdsOrderId: 'comanda-a' },
      data: { kdsOrderId: 'comanda-nueva' },
    })
    expect(prismaMock.kdsOrder.delete).toHaveBeenCalledWith({ where: { id: 'comanda-nueva' } })
  })

  it('la comanda entera cambia de dueño sólo si sigue siendo de quien se leyó', async () => {
    lecturasDeFilas([fila], [fila], [])
    prismaMock.kdsOrder.findMany.mockResolvedValue([comanda(1)] as any)
    prismaMock.kdsOrder.updateMany.mockResolvedValue({ count: 1 })

    expect(await ponerComandasConSuCuenta(prismaMock as any, 'venue-1', 'cuenta-a')).toEqual(['comanda-a'])

    expect(prismaMock.kdsOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'comanda-a', venueId: 'venue-1', orderId: 'cuenta-a', status: { not: 'COMPLETED' } },
      data: { orderId: 'cuenta-b', orderNumber: 'B-1' },
    })
  })

  it('toma el candado de comandas de la cuenta que recibe la pieza y vuelve a leer antes de moverla (Codex r3)', async () => {
    const leidas = lecturasDeFilas([fila], [])
    prismaMock.kdsOrder.findMany.mockResolvedValue([comanda(1)] as any)

    expect(await ponerComandasConSuCuenta(prismaMock as any, 'venue-1', 'cuenta-a')).toEqual([])

    const llamadas = prismaMock.$queryRaw.mock.calls as unknown[][]
    const candados = llamadas.filter(([q]) => sql(q).includes('pg_advisory_xact_lock'))
    expect(candados.map(([, llave]) => llave)).toEqual(['kds-order:cuenta-b'])
    expect(leidas).toHaveLength(2) // la segunda lectura, ya bajo candado, ve que otra caja ya la movió: no se escribe nada
    expect(prismaMock.kdsOrder.updateMany).not.toHaveBeenCalled()
  })

  it('si nunca puede avanzar, falla (y la anulación se reintenta) en vez de seguir y borrar lo ajeno', async () => {
    const leidas = lecturasDeFilas([fila])
    prismaMock.kdsOrder.findMany.mockResolvedValue([comanda(1)] as any)
    prismaMock.kdsOrder.updateMany.mockResolvedValue({ count: 0 })

    const error = await ponerComandasConSuCuenta(prismaMock as any, 'venue-1', 'cuenta-a').catch(e => e)
    expect(error).toMatchObject({ code: 'KDS_ORDER_OWNER_CHANGED', statusCode: 409 })
    // Sin red (CANCEL_ORDER, MERGE_ORDERS) se reintenta: nunca a cuarentena.
    expect(esErrorTransitorio(error)).toBe(true)
    expect(leidas).toHaveLength(11) // una para descubrir a quién bloquear y diez ya bajo candado
  })
})
