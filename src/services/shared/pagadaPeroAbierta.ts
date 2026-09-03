import { Prisma, type PrismaClient } from '@prisma/client'
import { utcTs } from '../../utils/sqlDates'

/**
 * Qué cobro CUENTA para cubrir la cuenta. Vive una sola vez porque lo usan lugares que NO
 * pueden divergir: la comparación del criterio, la columna `pagado` que reporta el barrido y
 * la que reporta el vigilante de dinero (check «PAGADA PERO ABIERTA», por eso se exporta). Si
 * uno sumara distinto del otro, el número que explica por qué se eligió una orden no sería
 * el que la eligió.
 *
 * 🔴 Los REFUND no restan. Misma regla que `summarizeRefunds` en `orderBalance.ts` (decisión
 * del founder 2026-08-18: «un reembolso NO reabre saldo») porque es exactamente lo que usa el
 * camino que cierra, `updateOrderTotalsForStandalonePayment`. Si esta suma restara los
 * reembolsos, una orden pagada y luego devuelta por completo sería `isFullyPaid` para quien
 * cierra y NO candidata para nosotros: el barrido nunca la alcanzaría.
 */
export const COBRO_QUE_CUBRE = `p.status = 'COMPLETED' AND p.type IS DISTINCT FROM 'REFUND'`

/**
 * Lo que la cuenta DEBE: `max(0, subtotal − descuento) + cargo por servicio`.
 *
 * Vive una sola vez por el mismo motivo que `COBRO_QUE_CUBRE` —es el OTRO lado de la misma
 * comparación— y lo usan tres sitios que no pueden divergir: el criterio, la columna `base`
 * del barrido y el detalle del vigilante de dinero. Cuando se re-derivaba a mano, el
 * vigilante explicaba una alerta con una cifra distinta de la que la disparó.
 *
 * 🔴 El cargo por servicio entra y la propina NO. El schema define
 * `Order.serviceChargeAmount` como «INGRESO GRAVABLE del negocio: SUMA al total y entra al
 * corte y al CFDI», mientras la propina pasa al mesero; y `computeOrderBalance`
 * (`shared/orderBalance.ts`) —la aritmética canónica del saldo— pone la propina a los DOS
 * lados (entra al total y entra a lo pagado), de modo que se cancela y la comparación se
 * reduce exactamente a ésta. El cargo va DESPUÉS del clamp: un descuento excedente se come
 * la mercancía, nunca los cargos.
 */
export function baseQueDebeCubrirseSql(alias = 'o'): string {
  return `GREATEST(0, ${alias}.subtotal - COALESCE(${alias}."discountAmount", 0)) + COALESCE(${alias}."serviceChargeAmount", 0)`
}

/**
 * Criterio ÚNICO de «orden cobrada que sigue abierta». Lo consumen el barrido
 * (`paid-order-reconciler.job.ts`) y el vigilante de dinero (check #6): si alguna vez
 * divergen, uno de los dos miente. Caso semilla: ORD-1788276418170 (Testarudo, 1-sep-2026).
 *
 * Reglas:
 *  - la orden no está en estado terminal;
 *  - la suma de sus cobros que cuentan (ver `COBRO_QUE_CUBRE`) cubre lo que la cuenta DEBE,
 *    `max(0, subtotal − descuento) + cargo por servicio`, con un centavo de tolerancia;
 *  - 🔴 el CARGO POR SERVICIO entra y la PROPINA no, y no es una asimetría arbitraria: el
 *    schema define `Order.serviceChargeAmount` como «INGRESO GRAVABLE del negocio: SUMA al
 *    total y entra al corte y al CFDI», mientras la propina pasa al mesero. Es exactamente
 *    lo que hace `computeOrderBalance` (`shared/orderBalance.ts`), la aritmética canónica
 *    del saldo: `total = mercancía + cargo + propinas` contra `pagado = Σ(amount + tip)`, de
 *    modo que la propina se cancela a los dos lados y la comparación se reduce a esta misma
 *    —`Σ amount >= mercancía + cargo`—. Omitiendo el cargo, una cuenta de $100 + $10 con
 *    $100 cobrados salía elegida como pagada: el barrido la cerraba, le reescribía el total
 *    hacia abajo y liberaba la mesa. $10 perdidos, en silencio (auditoría Codex 2-sep-2026);
 *  - la suma es CIEGA AL TIPO salvo REFUND: los TEST y los ADJUSTMENT cuentan, igual que
 *    en el camino de cierre. No se filtra por `type` más allá de excluir la devolución;
 *  - existe al menos un cobro REGULAR o FAST positivo — así una cuenta de $0 sin cobro
 *    (cortesía total) NO se marca pagada: ésa la cierra el cajero cobrando $0;
 *  - asimetría deliberada con `type` NULL: la puerta del EXISTS lo RECHAZA (un NULL no
 *    entra en un `IN (...)`) pero la suma sí lo CUENTA (`IS DISTINCT FROM` conserva los
 *    NULL). Es el lado conservador: un tipo desconocido no basta para declarar cobrada una
 *    orden, pero tampoco se ignora al sumar lo que ya entró.
 *
 * `alias` es texto de confianza (código propio), nunca entrada de usuario: se interpola
 * sin parametrizar y acaba dentro de un `$queryRawUnsafe`.
 */
export function criterioPagadaPeroAbiertaSql(alias = 'o'): string {
  const o = alias
  return `
    ${o}.status NOT IN ('COMPLETED', 'CANCELLED', 'DELETED')
    AND EXISTS (
      SELECT 1 FROM "Payment" p
      WHERE p."orderId" = ${o}.id AND p.status = 'COMPLETED'
        AND p.type IN ('REGULAR', 'FAST') AND p.amount > 0
    )
    AND (
      SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p
      WHERE p."orderId" = ${o}.id AND ${COBRO_QUE_CUBRE}
    ) >= ${baseQueDebeCubrirseSql(o)} - 0.01`
}

export interface CandidataPagadaAbierta {
  id: string
  venueId: string
  orderNumber: string
  status: string
  paymentStatus: string
  base: string
  pagado: string
  paymentIds: string[]
}

type Db = Pick<PrismaClient, '$queryRaw'> | Pick<Prisma.TransactionClient, '$queryRaw'>

/**
 * Candidatas, del más viejo al más nuevo, sin tocar órdenes actualizadas hace menos de `graceMs`.
 *
 * `base` y `pagado` reproducen los DOS lados de la comparación del criterio —el cargo por
 * servicio incluido— para que los números que explican por qué se eligió una orden sean los
 * que la eligieron; `pagado` aplica el MISMO filtro (`COBRO_QUE_CUBRE`). `paymentIds` en cambio
 * trae TODOS los COMPLETED, reembolsos incluidos: es rastro de auditoría, no la suma que manda
 * — nunca se suma.
 *
 * 🔴 `since` acota por `Order.createdAt` y es lo que hace barato el tic del barrido: el
 * criterio no tiene índice que sirva (`status NOT IN (...)`, `updatedAt <`), así que sin tope
 * cada pasada recorrería la historia entera de órdenes no terminales. El barrido periódico
 * pasa una ventana corta; el rezago viejo lo alcanza el script a mano, que pide la suya.
 */
export async function findPaidButOpenOrders(
  db: Db,
  opts: { graceMs: number; limit: number; now?: Date; since?: Date },
): Promise<CandidataPagadaAbierta[]> {
  const now = opts.now ?? new Date()
  const antesDe = new Date(now.getTime() - opts.graceMs)
  // `$queryRaw` con template: sólo los valores van parametrizados; el fragmento es texto fijo.
  const rows = await db.$queryRaw<CandidataPagadaAbierta[]>`
    SELECT o.id, o."venueId", o."orderNumber", o.status::text AS status, o."paymentStatus"::text AS "paymentStatus",
           (${Prisma.raw(baseQueDebeCubrirseSql('o'))})::text AS base,
           (SELECT COALESCE(SUM(p.amount), 0) FROM "Payment" p
             WHERE p."orderId" = o.id AND ${Prisma.raw(COBRO_QUE_CUBRE)})::text AS pagado,
           ARRAY(SELECT p.id FROM "Payment" p WHERE p."orderId" = o.id AND p.status = 'COMPLETED' ORDER BY p."createdAt") AS "paymentIds"
    FROM "Order" o
    WHERE ${Prisma.raw(criterioPagadaPeroAbiertaSql('o'))}
      AND o."updatedAt" < ${utcTs(antesDe)}
      ${opts.since ? Prisma.sql`AND o."createdAt" >= ${utcTs(opts.since)}` : Prisma.empty}
    ORDER BY o."createdAt" ASC
    LIMIT ${opts.limit}
  `
  return rows
}
