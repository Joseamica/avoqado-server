/**
 * Lo que la RAÍZ de una cadena de créditos de cambio todavía respalda (spec 2026-10-30-saldo-a-favor §5.4; Codex plan r4 hallazgo 2,
 * r5 hallazgo 1). Antes de pasar a saldo a favor lo devuelto de algo pagado con crédito, hay que saber que el dinero de la raíz sigue
 * ahí: si la terminal ya le devolvió la compra a la tarjeta, dar saldo encima sería devolver dos veces.
 *
 * Respaldo vigente = lo que cobró la raíz − la suma de sus REFUND (por ORIGEN económico, `sqlOrigenEconomico`) que sacaron dinero real:
 * banco/terminal, efectivo, transferencia y saldo a favor. **No cuenta** el gemelo del crédito de un Cambio (`role CREDIT`,
 * `exchangeTx.ts:541`): sólo pasó el valor a la venta nueva. Tampoco `refundedAmount`, que ese gemelo también sube.
 * (`laTerminalYaDevolvio` no sirve aquí: dice si la raíz se devuelve en terminal, no si ya se devolvió.)
 */
import type { Prisma } from '@prisma/client'
import AppError, { ConflictError } from '@/errors/AppError'
import { EXCHANGE_REFUND_ROLE, sqlOrigenEconomico } from '../exchanges/exchangeMarks'

/**
 * Aparta la raíz (`FOR UPDATE`) y devuelve su respaldo vigente en CENTAVOS (≥ 0). Las Orders de la cadena ya deben estar tomadas y la
 * raíz se aparta en el orden de Payments por id (el llamador decide cuándo). Sólo lee devoluciones COMPLETED.
 */
export async function respaldoVigenteDeLaRaiz(tx: Prisma.TransactionClient, rootPaymentId: string, venueId: string): Promise<number> {
  const [raiz] = await tx.$queryRaw<Array<{ cobradoCents: bigint | number }>>`
    SELECT ROUND((amount + "tipAmount") * 100)::bigint AS "cobradoCents"
    FROM "Payment"
    WHERE id = ${rootPaymentId} AND "venueId" = ${venueId}
    FOR UPDATE`
  if (!raiz) throw new ConflictError('El cobro original de este crédito ya no está disponible.', 'REFUND_AUTHORITY_UNAVAILABLE')
  const [suma] = await tx.$queryRaw<Array<{ devueltoCents: bigint | number | null }>>`
    SELECT COALESCE(ROUND(SUM(ABS(r.amount) + ABS(r."tipAmount")) * 100), 0)::bigint AS "devueltoCents"
    FROM "Payment" r
    WHERE r."venueId" = ${venueId}
      AND r.type = 'REFUND'
      AND r.status = 'COMPLETED'
      AND ${sqlOrigenEconomico('r')} = ${rootPaymentId}
      AND r."processorData"->'exchange'->>'role' IS DISTINCT FROM ${EXCHANGE_REFUND_ROLE.CREDIT}`
  return Math.max(0, Number(raiz.cobradoCents) - Number(suma?.devueltoCents ?? 0))
}

/** El rechazo cuando lo pedido pasa del respaldo vigente (Reembolso y Cambio): 422 sin escritura, con lo que todavía cabe. */
export function raizYaDevuelta(maxCents: number): AppError {
  return new AppError(
    maxCents === 0
      ? 'La compra original ya se devolvió.'
      : `La compra original ya se devolvió en parte: de este crédito sólo se pueden pasar $${(maxCents / 100).toFixed(2)} a saldo a favor.`,
    422,
    true,
    'STORE_CREDIT_ROOT_ALREADY_REFUNDED',
    { maxCents },
  )
}
