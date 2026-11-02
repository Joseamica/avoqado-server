/**
 * La pasada de lectores del saldo a favor (spec 2026-10-30-saldo-a-favor §5.3, tarea S8b; inventario y decisión de cada lector en el
 * workspace: docs/audit/2026-10-30-saldo-a-favor/lectores-de-systemkind.md).
 *
 * Un cobro con el medio de tarjetas puede canjear una tarjeta VENDIDA y un sobre de SALDO A FAVOR a la vez. Lo del sobre de saldo a
 * favor es venta normal (su devolución ya restó la venta original); el resto es saldo de tarjeta vendida, como hoy. Se clasifica POR
 * CANJE, con EL predicado del sobre (`esSobreDeSaldoAFavorSql`):
 *  - un cobro, por sus REDEEM (`paymentId`);
 *  - una devolución, por sus REDEEM_REVERSAL (`refundPaymentId`), nunca por la proporción de su cobro.
 * Tres formas: el mapa de un lote (los lectores síncronos lo cargan ANTES de su acumulador), la subconsulta (los que agregan en SQL) y el
 * filtro del medio `STORE_CREDIT` (vistas de dinero: la devolución a saldo no sacó dinero de la caja ni del banco).
 */
import { PaymentType, Prisma } from '@prisma/client'
import { ALIAS_SQL, esSobreDeSaldoAFavorSql } from '../giftCards/giftCardLedger'

function aliasCitado(alias: string): string {
  if (!ALIAS_SQL.test(alias)) throw new Error(`Alias SQL inválido: ${alias}`)
  return `"${alias}"`
}

/**
 * Los centavos (≥ 0, la magnitud: el signo es el del movimiento) de cada fila que salieron de —o regresaron a— un sobre de saldo a
 * favor. UNA consulta por lote, por los índices únicos de la libreta (`paymentId` y `refundPaymentId` van primero); sin filas, ninguna.
 * Una fila sin canje de saldo a favor no aparece en el mapa.
 */
export async function saldoAFavorPorFila(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  filas: ReadonlyArray<{ id: string; type: PaymentType | string | null }>,
): Promise<Map<string, number>> {
  const cobros = [...new Set(filas.filter(f => f.type !== PaymentType.REFUND).map(f => f.id))]
  const devoluciones = [...new Set(filas.filter(f => f.type === PaymentType.REFUND).map(f => f.id))]
  if (cobros.length + devoluciones.length === 0) return new Map()
  const rows = await db.$queryRaw<Array<{ id: string; cents: number }>>(Prisma.sql`
    SELECT CASE WHEN a.type = 'REDEEM' THEN a."paymentId" ELSE a."refundPaymentId" END AS id,
           ROUND(SUM(a.amount) * 100)::int AS cents
    FROM "GiftCardActivity" a
    JOIN "GiftCard" g ON g.id = a."giftCardId"
    WHERE ((a.type = 'REDEEM' AND a."paymentId" = ANY(${cobros}::text[]))
        OR (a.type = 'REDEEM_REVERSAL' AND a."refundPaymentId" = ANY(${devoluciones}::text[])))
      AND ${esSobreDeSaldoAFavorSql('g')}
    GROUP BY 1`)
  return new Map(rows.map(r => [r.id, Number(r.cents)]))
}

/** La misma suma (pesos, ≥ 0) como subconsulta escalar, para los lectores que agregan en SQL. `alias` = el de `"Payment"`. */
export function montoSaldoAFavorSql(aliasDelCobro: string): Prisma.Sql {
  const p = Prisma.raw(aliasCitado(aliasDelCobro))
  return Prisma.sql`(SELECT COALESCE(SUM(sf_a.amount), 0) FROM "GiftCardActivity" sf_a JOIN "GiftCard" sf_g ON sf_g.id = sf_a."giftCardId"
    WHERE ((sf_a.type = 'REDEEM' AND sf_a."paymentId" = ${p}.id) OR (sf_a.type = 'REDEEM_REVERSAL' AND sf_a."refundPaymentId" = ${p}.id))
      AND ${esSobreDeSaldoAFavorSql('sf_g')})`
}

/**
 * Vistas de DINERO: deja fuera la fila del medio `STORE_CREDIT` (sólo existe en devoluciones a saldo, que no sacaron dinero). NULL-safe:
 * `NOT EXISTS` deja pasar el cobro sin tender.
 */
export function sqlNoEsDelMedioSaldoAFavor(aliasDelCobro: string): Prisma.Sql {
  const p = aliasCitado(aliasDelCobro)
  return Prisma.raw(
    `NOT EXISTS (SELECT 1 FROM "VenueTenderType" sc_t WHERE sc_t."venueId" = ${p}."venueId" AND sc_t.id = ${p}."tenderTypeId" AND sc_t."systemKind" = 'STORE_CREDIT')`,
  )
}

/**
 * La parte de `netCents` (con signo) que NO salió de un sobre de saldo a favor, en proporción a lo canjeado: venta + propina, que es lo
 * que descuentan los REDEEM. Sin saldo a favor, `netCents` tal cual. Se redondea la MAGNITUD de la parte de saldo a favor y lo demás es
 * el resto: las dos partes suman exacto la fila, y una venta y su devolución completa se cancelan al centavo (`Math.round` con signo
 * llevaba el .5 hacia arriba en las dos y dejaba −1 centavo, con su aviso al contador).
 */
export function sinLaParteDeSaldoAFavor(netCents: number, canjeadoCents: number, saldoAFavorCents: number): number {
  const total = Math.abs(canjeadoCents)
  if (saldoAFavorCents <= 0 || total === 0) return netCents
  const deSaldoAFavor = Math.sign(netCents) * Math.round(Math.abs(netCents) * Math.min(1, saldoAFavorCents / total))
  return netCents - deSaldoAFavor
}
