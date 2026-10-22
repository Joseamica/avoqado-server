/**
 * «¿La venta tiene un reembolso?» decide si la lealtad tardía y el reconciliador le quitan su sello (spec 2026-10-20 §7.7: un
 * cambio no quita el sello de la venta original). Las devoluciones que escribe el cambio —el gemelo del crédito (`CREDIT`) y la
 * diferencia devuelta (`DIFFERENCE`)— no cuentan; la cadena (`CHAIN`, devolver algo pagado con crédito) y los reembolsos de
 * siempre, sí. Lo que dice cada fila de verdad se prueba contra Postgres en `tests/integration/exchanges/exchangeLoyalty`.
 */
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { ventaTieneReembolso } from '@/services/shared/ligaDeClienteEnVenta'
import { WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO } from '@/services/exchanges/exchangeMarks'

const venta = { venueId: 'venue-1', orderId: 'order-1' }

/** Todas las llaves de un objeto anidado (para buscar un `not` escondido). */
function llaves(valor: unknown): string[] {
  if (!valor || typeof valor !== 'object') return []
  return Object.entries(valor).flatMap(([k, v]) => [k, ...llaves(v)])
}

beforeEach(() => {
  prismaMock.payment.count.mockReset()
})

describe('ventaTieneReembolso · product exchange refunds', () => {
  it('ventaTieneReembolso counts only refunds that are not part of an exchange (one exact count, no capped list)', async () => {
    prismaMock.payment.count.mockResolvedValue(0)

    await ventaTieneReembolso(prismaMock, venta)

    expect(prismaMock.payment.count).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.count).toHaveBeenCalledWith({
      where: { ...venta, type: 'REFUND', status: 'COMPLETED', AND: [WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO] },
    })
  })

  it('ventaTieneReembolso is false when the only refunds are CREDIT or DIFFERENCE rows; true with an ordinary or CHAIN refund', async () => {
    // El conteo ya viene sin las filas del cambio: 0 = sólo había CREDIT/DIFFERENCE (o nada); 1 = un reembolso que sí cuenta.
    prismaMock.payment.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1)

    await expect(ventaTieneReembolso(prismaMock, venta)).resolves.toBe(false)
    await expect(ventaTieneReembolso(prismaMock, venta)).resolves.toBe(true)
  })

  it('the exchange mark is NULL-safe: it only names what counts (no NOT over the JSON path) and keeps refunds without processorData', () => {
    expect(llaves(WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO)).not.toContain('not')
    expect(llaves(WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO)).not.toContain('NOT')
    const ramas = WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO.OR.map(r => r.processorData)
    // Sin datos del procesador, sin papel de cambio, o la cadena.
    expect(ramas).toEqual([
      { equals: Prisma.AnyNull },
      { path: ['exchange', 'role'], equals: Prisma.AnyNull },
      { path: ['exchange', 'role'], equals: 'CHAIN' },
    ])
    expect(JSON.stringify(WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO)).not.toMatch(/CREDIT|DIFFERENCE/)
  })
})
