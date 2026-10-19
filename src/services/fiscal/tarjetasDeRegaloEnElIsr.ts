/**
 * B4 r1 (fix 2) · Tarjetas de regalo en el ISR estimado, fase 1.
 *
 * Dictamen §3: el ISR se causa al COBRAR. La venta de una tarjeta es un anticipo (ingreso del mes en que se cobra) y su canje no es un
 * ingreso nuevo. La base del ISR es el estado de resultados, que deja fuera las cuentas de tarjetas (B4) e incluye lo pagado con saldo
 * (es venta de mercancía): mueve el ingreso del mes de la venta al del canje. Fallo del contador para la fase 1 (opción b): la base NO se
 * recalcula; el ISR dice cuánto falta y cuánto sobra, y el contador ajusta con el reporte de tarjetas. La fase 2 (opción a) corrige la base.
 *
 * Los dos importes salen de la MISMA lectura que la base (`recorrerLibros`: la parte sin IVA de cada movimiento, con el mismo alcance
 * fiscal y el mismo periodo, y las devoluciones restando), así que son exactamente lo que la base deja fuera o mete:
 *  - `cargasCents`: lo cobrado por cuentas de tarjetas, neto de sus devoluciones (sin IVA: sus renglones son NO_OBJETO);
 *  - `pagadoConSaldoSinIvaCents`: la parte sin IVA de los cobros con saldo (tender de sistema), neta de sus devoluciones.
 * Las órdenes salen de las marcas de B1. Un negocio que nunca tuvo una tarjeta paga UNA consulta indexada y nada más.
 * Sólo lecturas, dentro de la foto de quien llama (recibe `tx`; no abre otra).
 */
import { PaymentType, Prisma, TransactionStatus } from '@prisma/client'
import { ValidationError } from '../../errors/AppError'
import { parseDbDateRange } from '../../utils/datetime'
import { utcTs } from '../../utils/sqlDates'
import { LOTE_DE_ORDENES, type LimitesDelReporte } from '../dashboard/accounting.dashboard.service'
import { sqlCobroNoEsSaldoDeRegalo, sqlOrdenSinTarjetas, WHERE_COBRO_ES_SALDO_DE_REGALO } from '../giftCards/giftCardMarks'
import { metodoParaAlcanceFiscal, paymentInFiscalScope } from './fiscalScope'
import { recorrerLibros, TOPES_POR_ORDEN } from './librosDeOrdenes'

export type TarjetasEnElIsr = { cargasCents: number; pagadoConSaldoSinIvaCents: number }

/**
 * Las órdenes con un movimiento de tarjetas en el periodo —cuentas de tarjetas, o con un cobro con saldo—, una vez cada una, en orden,
 * con la marca de si es cuenta de tarjetas. Las mismas condiciones que `sqlDeOrdenesDelPeriodo` más las marcas de B1, sin parámetros nuevos.
 */
export const sqlDeOrdenesConTarjetasDelPeriodo = (venueId: string, from: Date, to: Date, limite: number) => Prisma.sql`
  SELECT p."orderId" AS "orderId", NOT (${sqlOrdenSinTarjetas('p."orderId"')}) AS "deTarjetas"
  FROM "Payment" p
  JOIN "Order" o ON o.id = p."orderId"
  WHERE p."venueId" = ${venueId}
    AND p.status = 'COMPLETED'
    AND p."createdAt" >= ${utcTs(from)}
    AND p."createdAt" <= ${utcTs(to)}
    AND o."venueId" = ${venueId}
    AND o.status <> 'CANCELLED'
    AND (NOT (${sqlOrdenSinTarjetas('o.id')}) OR NOT (${sqlCobroNoEsSaldoDeRegalo('p')}))
  GROUP BY p."orderId"
  ORDER BY p."orderId"
  LIMIT ${limite}`

/** Lo que el ISR deja fuera (cargas) y mete (pagado con saldo, sin IVA) de las tarjetas de regalo de UN local en [from, to]. */
export async function tarjetasDeRegaloEnFoto(
  tx: Prisma.TransactionClient,
  venue: { id: string; timezone: string | null },
  filters: { from: string; to: string },
  limites: LimitesDelReporte,
): Promise<TarjetasEnElIsr> {
  const venueId = venue.id
  const nada: TarjetasEnElIsr = { cargasCents: 0, pagadoConSaldoSinIvaCents: 0 }
  // Sin una sola tarjeta no hay cuentas de tarjetas ni cobros con saldo (los dos apuntan a un sobre del negocio).
  if (!(await tx.giftCard.findFirst({ where: { venueId }, select: { id: true } }))) return nada

  const { from, to } = parseDbDateRange(filters.from, filters.to, venue.timezone || 'America/Mexico_City')
  // El alcance fiscal, como `estadoDeResultadosEnFoto`: el efectivo sólo con el opt-in del primer emisor.
  const emisor = await tx.fiscalEmisor.findFirst({
    where: { venueId },
    orderBy: { createdAt: 'asc' },
    select: { includeCashInAccounting: true },
  })
  const includeCashInAccounting = emisor?.includeCashInAccounting ?? false

  const filas = await tx.$queryRaw<Array<{ orderId: string; deTarjetas: boolean }>>(
    sqlDeOrdenesConTarjetasDelPeriodo(venueId, from, to, limites.maxOrdenes + 1),
  )
  if (filas.length > limites.maxOrdenes) {
    throw new ValidationError(
      `El periodo tiene más de ${limites.maxOrdenes.toLocaleString('es-MX')} ventas y no se puede calcular de una vez; elige un rango más corto.`,
      'REPORT_TOO_LARGE',
      { motivo: 'PERIODO', limite: limites.maxOrdenes },
    )
  }
  const deTarjetas = new Set(filas.filter(f => f.deTarjetas).map(f => f.orderId))

  let cargasCents = 0
  let pagadoConSaldoSinIvaCents = 0
  for (let i = 0; i < filas.length; i += LOTE_DE_ORDENES) {
    const lote = filas.slice(i, i + LOTE_DE_ORDENES).map(f => f.orderId)
    const deMercancia = lote.filter(id => !deTarjetas.has(id))
    const conSaldo = new Set(
      deMercancia.length === 0
        ? []
        : (
            await tx.payment.findMany({
              take: deMercancia.length * TOPES_POR_ORDEN.movimientos,
              where: {
                venueId,
                orderId: { in: deMercancia },
                status: TransactionStatus.COMPLETED,
                createdAt: { gte: from, lte: to },
                ...WHERE_COBRO_ES_SALDO_DE_REGALO,
              },
              select: { id: true },
              orderBy: { id: 'asc' },
            })
          ).map(p => p.id),
    )
    // Las mismas reglas que `sumarMovimiento` del estado de resultados: del periodo, en el alcance fiscal, la parte con su signo.
    await recorrerLibros(tx, { venueId, orderIds: lote, hasta: to }, (m, parte) => {
      if (m.createdAt < from || m.createdAt > to) return
      const metodo = m.type === PaymentType.REFUND ? metodoParaAlcanceFiscal(m.method, m.processorData) : m.method
      if (!paymentInFiscalScope(metodo, m.incluirEnContabilidad, includeCashInAccounting)) return
      if (deTarjetas.has(m.orderId)) cargasCents += parte.netCents
      else if (conSaldo.has(m.id)) pagadoConSaldoSinIvaCents += parte.netCents
    })
  }
  return { cargasCents, pagadoConSaldoSinIvaCents }
}
