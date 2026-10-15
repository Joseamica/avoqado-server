/**
 * Las dos marcas con que toda la plataforma se entera de las tarjetas de regalo (índice 1a, R4 y R11). Una sola definición para
 * factura, contabilidad, ventas, turno, lealtad, comisiones y la revisión nocturna: si alguna copia la regla a mano, divergen.
 */
// `Prisma.Sql` es sólo un TIPO en esta versión de Prisma; la clase en tiempo de ejecución vive en el runtime.
import { Sql } from '@prisma/client/runtime/library'
import {
  leerSiEsCuentaDeTarjetas,
  sqlCobroNoEsSaldoDeRegalo,
  sqlCobroNoEsSaldoDeRegaloTexto,
  sqlOrdenSinTarjetas,
  sqlOrdenSinTarjetasTexto,
  WHERE_COBRO_ES_SALDO_DE_REGALO,
  WHERE_COBRO_NO_ES_SALDO_DE_REGALO,
  WHERE_ORDEN_DE_TARJETAS,
  WHERE_ORDEN_SIN_TARJETAS,
  WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE,
} from '@/services/giftCards/giftCardMarks'

/** Un lector falso: responde a «¿hay un renglón con tarjeta?» y a «¿hay uno sin tarjeta?». */
function lector(hayConTarjeta: boolean, haySinTarjeta: boolean) {
  const findFirst = jest.fn().mockImplementation(({ where }: { where: { giftCardId: unknown } }) => {
    if (where.giftCardId === null) return Promise.resolve(haySinTarjeta ? { id: 'oi-merc' } : null)
    return Promise.resolve(hayConTarjeta ? { id: 'oi-gc' } : null)
  })
  return { db: { orderItem: { findFirst } } as never, findFirst }
}

describe('leerSiEsCuentaDeTarjetas (R11)', () => {
  it('sólo renglones de tarjeta ⇒ es cuenta de tarjetas', async () => {
    const { db } = lector(true, false)
    await expect(leerSiEsCuentaDeTarjetas(db, 'o1')).resolves.toBe(true)
  })

  it('sin renglones de tarjeta ⇒ no lo es, con UNA sola consulta (el camino de toda venta normal)', async () => {
    const { db, findFirst } = lector(false, true)
    await expect(leerSiEsCuentaDeTarjetas(db, 'o1')).resolves.toBe(false)
    expect(findFirst).toHaveBeenCalledTimes(1)
    expect(findFirst).toHaveBeenCalledWith({ where: { orderId: 'o1', giftCardId: { not: null } }, select: { id: true } })
  })

  it('mezclada (el servidor no la deja nacer, A5) ⇒ no se trata como cuenta de tarjetas', async () => {
    const { db } = lector(true, true)
    await expect(leerSiEsCuentaDeTarjetas(db, 'o1')).resolves.toBe(false)
  })
})

describe('marcas para consultas de Prisma', () => {
  it('cuenta de tarjetas y su negación', () => {
    expect(WHERE_ORDEN_DE_TARJETAS).toEqual({ items: { some: { giftCardId: { not: null } } } })
    expect(WHERE_ORDEN_SIN_TARJETAS).toEqual({ items: { none: { giftCardId: { not: null } } } })
  })

  it('cobro con saldo: por la marca del tender, nunca por el método (OTHER también es de los vales)', () => {
    expect(WHERE_COBRO_ES_SALDO_DE_REGALO).toEqual({ tenderType: { is: { systemKind: 'GIFT_CARD' } } })
  })

  it('«no es saldo» deja pasar el cobro SIN tender (efectivo clásico) y el de un tender propio: es NULL-safe', () => {
    expect(WHERE_COBRO_NO_ES_SALDO_DE_REGALO).toEqual({
      OR: [{ tenderTypeId: null }, { tenderType: { is: { systemKind: null } } }],
    })
  })

  it('pendiente de revisión contable = cobro con saldo O cualquier cobro de una cuenta de tarjetas', () => {
    expect(WHERE_PAGO_PENDIENTE_DE_REVISION_CONTABLE).toEqual({
      OR: [WHERE_COBRO_ES_SALDO_DE_REGALO, { order: WHERE_ORDEN_DE_TARJETAS }],
    })
  })
})

describe('fragmentos de SQL crudo (sin parámetros: la columna es una de una lista cerrada)', () => {
  it('cuenta sin tarjetas por su columna de orden', () => {
    expect(sqlOrdenSinTarjetasTexto('"Order".id')).toBe(
      'NOT EXISTS (SELECT 1 FROM "OrderItem" gc_oi WHERE gc_oi."orderId" = "Order".id AND gc_oi."giftCardId" IS NOT NULL)',
    )
    const sql = sqlOrdenSinTarjetas('p."orderId"')
    expect(sql).toBeInstanceOf(Sql)
    expect(sql.values).toEqual([])
    expect(sql.sql).toContain('gc_oi."orderId" = p."orderId"')
  })

  it('cobro que no es saldo de regalo', () => {
    expect(sqlCobroNoEsSaldoDeRegaloTexto('p')).toBe(
      `NOT EXISTS (SELECT 1 FROM "VenueTenderType" gc_t WHERE gc_t."venueId" = p."venueId" AND gc_t.id = p."tenderTypeId" AND gc_t."systemKind" = 'GIFT_CARD')`,
    )
    expect(sqlCobroNoEsSaldoDeRegalo('p').values).toEqual([])
  })
})
