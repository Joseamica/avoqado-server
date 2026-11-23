/**
 * Lo cobrado por adelantado que NO es venta del Resumen de ventas (carril G, hz:fefa11b6:D5, 22-nov-2026).
 *
 * Dos entradas de dinero no crean `Order` ni `Payment`, así que el reporte no las veía en ningún lado:
 * - el paquete de clases comprado en línea (`fulfillPurchase`, webhook de Stripe Connect): única que llena `stripeCheckoutSessionId`.
 *   El paquete vendido en la caja pasa por una cuenta (`fulfillCreditPacksForOrder`, `sellPackInPerson`) y ya está en ventas;
 * - el depósito de una reserva (`Reservation.depositAmount`, cobrado por Stripe): sólo marca `depositStatus = PAID` y `depositPaidAt`.
 *
 * Son anticipos (decisión del founder del 22-nov, hz:fefa11b6:D5 «A»): como «Tarjetas de regalo cargadas» y como el «Deferred» de
 * Square y Toast, renglones informativos aparte, por la fecha en que se cobraron, FUERA de ventas y de «Neto cobrado». Contarlos como
 * venta al usarse (la clase tomada, la reserva que llega) es un proyecto aparte.
 *
 * - Paquetes: en pesos; los de otra moneda aparte, nunca sumados (Codex r2 #5). Por `purchasedAt`, la hora en que Avoqado recibió la confirmación del pago (el aviso de Stripe llega segundos después;
 *   si tarda, puede caer al día siguiente: no se guarda la hora del cargo, Codex r1 #8). Todos los estados: el «reembolsado» del
 *   panel sólo marca, no regresa dinero (`creditPack.dashboard.service`), y no guarda cuándo.
 * - Depósitos: lo cobrado en el rango (`depositPaidAt`) menos lo devuelto en el rango (`REFUNDED` + `depositRefundedAt`), con el
 *   conteo de los cobrados. Uno perdido por no-show (`FORFEITED`) o en disputa conserva su cobro. Sin `depositPaidAt` no hay fecha
 *   de cobro y no se cuenta.
 */
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

export interface PrepaidOutsideSales {
  /** Paquetes en pesos (los del reporte). */
  packagesSoldOnline: number
  packagesSoldOnlineCount: number
  /**
   * Paquetes cobrados en OTRA moneda (el panel deja crear paquetes en USD): nunca se suman a los pesos (Codex r2 #5). Sólo si hay.
   * La moneda es la del paquete hoy: la compra no guarda la suya (guardarla pide tocar el esquema).
   */
  packagesSoldOnlineOtherCurrencies?: Array<{ currency: string; amount: number; count: number }>
  /** Cobrado en el rango menos lo devuelto en el rango (neto). */
  reservationDeposits: number
  /** Cuántos depósitos se cobraron en el rango. */
  reservationDepositsCount: number
  /** Lo devuelto en el rango (de depósitos de cualquier día): con él, un cobro y su devolución del mismo día no desaparecen ($0 neto). */
  reservationDepositsRefunded: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

export async function computePrepaidOutsideSales(
  venueId: string,
  start: Date,
  end: Date,
  db: Pick<typeof prisma, '$queryRaw'> = prisma,
): Promise<PrepaidOutsideSales> {
  const [paquetes, depositos] = await Promise.all([
    db.$queryRaw<Array<{ moneda: string; importe: string; cuantos: number }>>`
      SELECT UPPER(COALESCE(NULLIF(cp.currency, ''), 'MXN')) AS moneda, COALESCE(SUM(cpp."amountPaid"), 0)::text AS importe, COUNT(*)::int AS cuantos
      FROM "CreditPackPurchase" cpp
      JOIN "CreditPack" cp ON cp.id = cpp."creditPackId"
      WHERE cpp."venueId" = ${venueId}
        AND cpp."stripeCheckoutSessionId" IS NOT NULL
        AND cpp."purchasedAt" >= ${utcTs(start)}
        AND cpp."purchasedAt" <= ${utcTs(end)}
      GROUP BY 1
      ORDER BY 1
    `,
    // El filtro por `depositStatus` (sólo los que alguna vez se cobraron) deja que Postgres use su índice: casi ninguna reserva lleva
    // depósito, así que no recorre las reservas del negocio.
    db.$queryRaw<Array<{ cobrado: string; cuantos: number; devuelto: string }>>`
      SELECT
        COALESCE(SUM("depositAmount") FILTER (WHERE "depositPaidAt" >= ${utcTs(start)} AND "depositPaidAt" <= ${utcTs(end)}), 0)::text AS cobrado,
        (COUNT(*) FILTER (WHERE "depositPaidAt" >= ${utcTs(start)} AND "depositPaidAt" <= ${utcTs(end)}))::int AS cuantos,
        COALESCE(SUM("depositAmount") FILTER (
          WHERE "depositStatus" = 'REFUNDED' AND "depositRefundedAt" >= ${utcTs(start)} AND "depositRefundedAt" <= ${utcTs(end)}
        ), 0)::text AS devuelto
      FROM "Reservation"
      WHERE "venueId" = ${venueId}
        AND "depositStatus" IN ('PAID', 'REFUNDED', 'FORFEITED', 'DISPUTED')
        AND "depositAmount" IS NOT NULL
        AND (
          ("depositPaidAt" >= ${utcTs(start)} AND "depositPaidAt" <= ${utcTs(end)})
          OR ("depositRefundedAt" >= ${utcTs(start)} AND "depositRefundedAt" <= ${utcTs(end)})
        )
    `,
  ])
  const pesos = paquetes.find(p => p.moneda === 'MXN')
  const otras = paquetes
    .filter(p => p.moneda !== 'MXN')
    .map(p => ({ currency: p.moneda, amount: round2(Number(p.importe)), count: Number(p.cuantos) }))
  return {
    packagesSoldOnline: round2(Number(pesos?.importe ?? 0)),
    packagesSoldOnlineCount: Number(pesos?.cuantos ?? 0),
    ...(otras.length > 0 ? { packagesSoldOnlineOtherCurrencies: otras } : {}),
    reservationDeposits: round2(Number(depositos[0]?.cobrado ?? 0) - Number(depositos[0]?.devuelto ?? 0)),
    reservationDepositsCount: Number(depositos[0]?.cuantos ?? 0),
    reservationDepositsRefunded: round2(Number(depositos[0]?.devuelto ?? 0)),
  }
}
