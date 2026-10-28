// src/services/exchanges/exchangeMarks.ts
/**
 * Las MARCAS con que el resto de la plataforma se entera del cambio de producto (spec 2026-10-20 §6.2 y §6.7):
 *
 * - **Cobro con crédito de cambio**: un `Payment` cuyo tender tiene `systemKind = EXCHANGE_CREDIT`, el kind EXACTO. Nunca por
 *   `method` (`OTHER` también es de los vales y de los tipos del negocio) ni por «tiene algún systemKind»: el saldo de regalo es
 *   otra cosa y sus marcas viven, sin tocarse, en `giftCards/giftCardMarks.ts`.
 * - **Origen económico de una devolución**: `processorData.rootPaymentId ?? processorData.originalPaymentId`. Lo que se devuelve
 *   de algo pagado con crédito apunta al cobro con crédito, pero el dinero salió de la RAÍZ (§6.7). Una sola regla en TS, SQL y
 *   `where`; los topes, las repeticiones y el detalle del cobro siguen leyendo `originalPaymentId`.
 * - **Dinero de un cambio**: los cobros que no se editan ni se borran a mano.
 *
 * 🔴 Toda marca con `OR` se compone dentro de `AND: [...]`: dos `OR` esparcidos en el mismo `where` se pisan sin error.
 */
import { Prisma, TenderSystemKind } from '@prisma/client'
import { ConflictError } from '@/errors/AppError'

/**
 * La venta nueva de un cambio que todavía espera el cobro de la diferencia: nace `CONFIRMED/PENDING` con el precio COMPLETO (el
 * crédito se aplica al cerrar) y su `externalId` es `exchange:<llave>` (`exchangeTx.createExchangeSaleInTx`). No se ofrece en listas
 * cobrables: una TPV vieja o el POS la cobraban completa en vez de la diferencia (MKT_26_oct, codex-apps-viejas-r2, 28-oct). Ya
 * pagada vuelve a verse. NULL-safe: sin `externalId` cuenta. Lleva `OR`: va dentro de `AND: [...]`.
 */
export const WHERE_NO_ES_CUENTA_APARTADA_DE_CAMBIO = {
  OR: [
    { externalId: null },
    { NOT: { externalId: { startsWith: 'exchange:' } } },
    { paymentStatus: { notIn: ['PENDING', 'PARTIAL'] } },
  ],
} satisfies Prisma.OrderWhereInput

export const WHERE_PAYMENT_IS_EXCHANGE_CREDIT = {
  tenderType: { is: { systemKind: TenderSystemKind.EXCHANGE_CREDIT } },
} satisfies Prisma.PaymentWhereInput

/**
 * 🔴 NULL-safe a propósito: en SQL, `systemKind <> 'EXCHANGE_CREDIT'` descarta las filas con `systemKind` NULL, y la relación
 * opcional, las que no tienen tender (el efectivo clásico). Así, sin tender, con un tender del negocio o con el de regalo, cuenta.
 */
export const WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT = {
  OR: [
    { tenderTypeId: null },
    { tenderType: { is: { systemKind: null } } },
    { tenderType: { is: { systemKind: { not: TenderSystemKind.EXCHANGE_CREDIT } } } },
  ],
} satisfies Prisma.PaymentWhereInput

/** Alias de `"Payment"` admitidos en SQL crudo. Lista cerrada: nunca texto que venga de fuera. */
type AliasDeCobro = 'p' | 'r'

/** El gemelo en SQL de `WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT` (`NOT EXISTS` ya es NULL-safe). */
export function sqlPaymentIsNotExchangeCredit(alias: AliasDeCobro): Prisma.Sql {
  return Prisma.raw(
    `NOT EXISTS (SELECT 1 FROM "VenueTenderType" ec_t WHERE ec_t."venueId" = ${alias}."venueId" AND ec_t.id = ${alias}."tenderTypeId" AND ec_t."systemKind" = 'EXCHANGE_CREDIT')`,
  )
}

/**
 * Los papeles que un cambio escribe en `processorData.exchange.role` de sus devoluciones. Lista CERRADA y única: la usan el
 * escritor del cambio, `WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO` y `exchangeProtectedPayments`; un papel nuevo se decide aquí.
 *   · `CREDIT`: el gemelo del crédito en la venta original.
 *   · `DIFFERENCE`: la diferencia devuelta.
 *   · `CHAIN`: lo devuelto de algo pagado con crédito (§6.7); ése sí es una devolución.
 */
export const EXCHANGE_REFUND_ROLE = { CREDIT: 'CREDIT', DIFFERENCE: 'DIFFERENCE', CHAIN: 'CHAIN' } as const
export type ExchangeRefundRole = (typeof EXCHANGE_REFUND_ROLE)[keyof typeof EXCHANGE_REFUND_ROLE]
export const EXCHANGE_REFUND_ROLES: readonly ExchangeRefundRole[] = [
  EXCHANGE_REFUND_ROLE.CREDIT,
  EXCHANGE_REFUND_ROLE.DIFFERENCE,
  EXCHANGE_REFUND_ROLE.CHAIN,
]

/**
 * ¿La orden es la VENTA NUEVA de un cambio? No es una compra nueva (spec §7.6 y §7.7): no dispara referidos, ni con la diferencia
 * cobrada, y no da sello. Una lectura por el índice único de `Exchange.newOrderId`.
 */
export async function esVentaNuevaDeCambio(db: Pick<Prisma.TransactionClient, 'exchange'>, orderId: string | null): Promise<boolean> {
  if (!orderId) return false
  return !!(await db.exchange.findUnique({ where: { newOrderId: orderId }, select: { id: true } }))
}

/**
 * Las devoluciones que NO son parte de un cambio (spec §7.7: un cambio no le quita el sello a la venta original): las de siempre
 * (sin `processorData`, o sin papel de cambio en `processorData.exchange.role`) y las de la CADENA (`CHAIN`: devolver algo pagado
 * con crédito sí es una devolución). Quedan fuera el gemelo del crédito (`CREDIT`) y la diferencia devuelta (`DIFFERENCE`).
 * 🔴 Nombra lo que CUENTA, a propósito: un `NOT` sobre la ruta JSON da NULL cuando falta la llave y dejaría fuera, sin error, las
 * devoluciones de siempre. Un papel nuevo de `EXCHANGE_REFUND_ROLE` no cuenta hasta agregarlo aquí. Lleva `OR`: va dentro de
 * `AND: [...]`.
 */
export const WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO = {
  OR: [
    { processorData: { equals: Prisma.AnyNull } },
    { processorData: { path: ['exchange', 'role'], equals: Prisma.AnyNull } },
    { processorData: { path: ['exchange', 'role'], equals: EXCHANGE_REFUND_ROLE.CHAIN } },
  ],
} satisfies Prisma.PaymentWhereInput

/** El cobro de donde SALIÓ el dinero de una devolución: la raíz de la cadena si la hay, si no el cobro devuelto. */
export function origenEconomicoDeDevolucion(processorData: unknown): string | null {
  if (!processorData || typeof processorData !== 'object' || Array.isArray(processorData)) return null
  const pd = processorData as { rootPaymentId?: unknown; originalPaymentId?: unknown }
  const origen = pd.rootPaymentId ?? pd.originalPaymentId
  return typeof origen === 'string' ? origen : null
}

/** El gemelo en SQL: `->>` da NULL si falta la llave o vale JSON null, y entonces cuenta el cobro devuelto. */
export function sqlOrigenEconomico(alias: AliasDeCobro): Prisma.Sql {
  return Prisma.raw(`COALESCE(${alias}."processorData"->>'rootPaymentId', ${alias}."processorData"->>'originalPaymentId')`)
}

/** El gemelo en `where`: las devoluciones cuyo origen económico es `paymentId`. Lleva `OR`: va dentro de `AND: [...]`. */
export function whereDevolucionConOrigen(paymentId: string): Prisma.PaymentWhereInput {
  return {
    OR: [
      { processorData: { path: ['rootPaymentId'], equals: paymentId } },
      {
        AND: [
          { processorData: { path: ['rootPaymentId'], equals: Prisma.AnyNull } },
          { processorData: { path: ['originalPaymentId'], equals: paymentId } },
        ],
      },
    ],
  }
}

/**
 * Los ids, entre los dados, que son DINERO DE UN CAMBIO (spec §6.2 y §6.7). Su importe, propina, estado y método no se editan a
 * mano ni se borran: la cuenta del cambio (lo regresado, lo aplicado a la venta nueva y la diferencia) dejaría de cuadrar sin que
 * se moviera dinero real, y la raíz ya ligada sostiene los topes de la cadena. Son:
 * - el cobro con crédito de la venta nueva y su REFUND gemelo en la original (los dos llevan el tender del crédito);
 * - las filas de la diferencia: la devuelta (`processorData.exchange.role`) y la cobrada (cobro, no reembolso, de la venta nueva);
 * - lo devuelto de algo pagado con crédito (la cadena, `role CHAIN`): sus importes sostienen los topes de la cadena (§6.7);
 * - la raíz que ya dio crédito (`ExchangeCreditLink.originPaymentId`).
 * Una consulta. Se llama con la transacción que YA bloqueó el cobro, para decidir sobre lo vigente.
 */
export async function exchangeProtectedPayments(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  paymentIds: readonly string[],
): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set()
  const filas = await db.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM "Payment" p
    WHERE p.id IN (${Prisma.join([...paymentIds])})
      AND (
        NOT (${sqlPaymentIsNotExchangeCredit('p')})
        OR p."processorData"->'exchange'->>'role' IN (${Prisma.join([...EXCHANGE_REFUND_ROLES])})
        OR (
          p."type" IS DISTINCT FROM 'REFUND'
          AND EXISTS (SELECT 1 FROM "Exchange" x WHERE x."venueId" = p."venueId" AND x."newOrderId" = p."orderId")
        )
        OR EXISTS (SELECT 1 FROM "ExchangeCreditLink" l WHERE l."venueId" = p."venueId" AND l."originPaymentId" = p.id)
      )`
  return new Set(filas.map(f => f.id))
}

/** El 409 de un cobro que es dinero de un cambio. `fields`: lo económico que se quiso cambiar, o `['delete']`. */
export function paymentProtectedByExchange(paymentId: string, fields: string[]): ConflictError {
  return new ConflictError(
    'Este cobro es parte de un cambio de producto: su importe, propina, estado y forma de pago no se cambian a mano, y no se borra. Para regresar dinero haz un reembolso; los datos de referencia sí se pueden corregir.',
    'PAYMENT_PROTECTED_BY_EXCHANGE',
    { paymentId, fields },
  )
}
