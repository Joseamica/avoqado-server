import { Prisma } from '@prisma/client'
import { ForbiddenError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { isDeadlockError, isRetryableDbError } from '../../utils/serializableRetry'
import { computeOrderBalance, esVentaCerrada, type OrderAmountsForBalance } from './orderBalance'
import { WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO } from '../exchanges/exchangeMarks'

/**
 * La liga de un cliente a una venta (`OrderCustomer`) ante choques de únicos, en UN solo lugar para el POS (móvil y MCP) y la
 * TPV (BAJO-3 + M1/M2 de la ronda 1 post-QA de sellos tardíos, 15-oct-2026).
 *
 * `OrderCustomer` tiene dos únicos que pueden chocar cuando dos «agregar cliente» corren a la vez: `(orderId, customerId)` y el
 * parcial del primario `(orderId) WHERE isPrimary`. Cuál reporta Postgres depende del orden en que revisa los índices (hoy, el
 * de su OID; un `REINDEX CONCURRENTLY` lo puede voltear), así que NO se decide por el índice del error: ante CUALQUIER P2002
 * se RELEE si este cliente quedó ligado a la venta.
 */

/** ¿Es un choque de único (P2002)? Un `PrismaClientKnownRequestError` o cualquier error con ese `code`. */
export function esChoqueDeUnico(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
}

/** Por qué se reintenta una transacción de liga: choque de único, interbloqueo (40P01) o serialización (P2034, P2010/40001). */
export type MotivoDeReintentoDeLiga = 'UNICO' | 'INTERBLOQUEO' | 'SERIALIZACION'

/**
 * R3-2/R3-3 (ronda 3): UN solo clasificador para todos los caminos de liga (POS/MCP, TPV «agregar», «crear y agregar», `/fast`).
 * El `SELECT … FOR NO KEY UPDATE` crudo deja la serialización como P2010/40001 y el interbloqueo como P2010/40P01 (Prisma no los
 * traduce); en una consulta de modelo llegan como P2034 o como error desconocido. `null` = no se reintenta.
 */
export function motivoDeReintentoDeLiga(error: unknown): MotivoDeReintentoDeLiga | null {
  if (esChoqueDeUnico(error)) return 'UNICO'
  if (isDeadlockError(error)) return 'INTERBLOQUEO'
  if (isRetryableDbError(error)) return 'SERIALIZACION'
  return null
}

/** Texto del log de un reintento (los interbloqueos se dicen con esa palabra: las pruebas de los cruces los buscan). */
export function etiquetaDeReintento(motivo: MotivoDeReintentoDeLiga): string {
  return motivo === 'INTERBLOQUEO' ? 'interbloqueo (40P01)' : motivo === 'UNICO' ? 'choque de único (P2002)' : 'serialización'
}

/** ¿Este cliente ya está ligado a la venta? (relectura fuera de la transacción que chocó). */
export async function clienteYaLigadoALaVenta(orderId: string, customerId: string): Promise<boolean> {
  const liga = await prisma.orderCustomer.findUnique({
    where: { orderId_customerId: { orderId, customerId } },
    select: { id: true },
  })
  return liga !== null
}

/**
 * 🔴 R3-2 (ronda 3 post-QA de sellos tardíos; Codex recheck-7 P2-2): el candado de la VENTA para toda escritura de su atribución
 * (ligas del POS, del MCP y de la TPV, quitar cliente, editar invitado y el relleno de `/fast`). Es la PRIMERA sentencia de su
 * transacción. Devuelve `false` si la venta no es de este negocio.
 *
 * `FOR NO KEY UPDATE`, no `FOR UPDATE`:
 *   · serializa contra el cobro (que toma `FOR UPDATE` con `lockExistingOrderForPayment`), contra el reconciliador y el cierre de la
 *     lealtad (que actualizan la fila) y entre estas escrituras (todas toman este mismo modo): la decisión se toma con el estado
 *     vigente;
 *   · y NO choca con el `FOR KEY SHARE` que Postgres toma sobre la venta al revisar una llave foránea. Con `FOR UPDATE`, la liga
 *     (venta → al insertar su vínculo pide `Customer`) y las métricas del cobro (`Customer FOR UPDATE` → al registrar la visita
 *     piden la venta) se interbloqueaban. Así las métricas nunca esperan a una liga, y el camino del cobro no se tocó.
 */
export async function bloquearVentaParaLiga(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { venueId: string; orderId: string },
): Promise<boolean> {
  if (typeof tx.$queryRaw !== 'function') {
    throw new Error('bloquearVentaParaLiga requiere una transacción con $queryRaw')
  }
  const filas = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Order"
    WHERE id = ${input.orderId} AND "venueId" = ${input.venueId}
    FOR NO KEY UPDATE
  `
  return Array.isArray(filas) && filas.length === 1
}

/**
 * ¿La venta ya está cobrada? PAID o REFUNDED (`esVentaCerrada`, la definición única de `orderBalance.ts`): lo que dice la venta leída
 * BAJO el candado de quien llama. Ahí aplica la decisión «A» del founder. Nadie guarda una copia local. R8-1 (ronda 8): ningún cobro
 * que ENTRA la baja a PARTIAL (`estadoDeCobroAlRecibirDinero`), así que este predicado no se puede esquivar recibiendo dinero.
 *
 * 🔴 R7-2 (ronda 7 post-QA de sellos tardíos; Codex recheck-11 P2): la ronda 6 sumaba «tiene un reembolso COMPLETED» como marca de
 * «ya se cobró alguna vez». Se quitó: (1) bloqueaba cuentas que NUNCA se saldaron (abono de $20 y devolución de $10); (2) no era
 * universal — corregir o cancelar un cobro desde el panel (`payment.dashboard.service.ts#updatePayment`) también deja saldo en una
 * venta PAID sin ningún reembolso. Lo que la marca quería cerrar (volver a cobrar una venta ya cobrada con el pago manual y colar un
 * cliente) lo cierra R7-1 de raíz: el pago manual rechaza la venta PAID/REFUNDED para todos (`manualPayment.service.ts`).
 */
export function esVentaYaCobrada(venta: { paymentStatus: string | null | undefined }): boolean {
  return esVentaCerrada(venta.paymentStatus)
}

/** Los campos de la venta que decide `ventaYaCobradaBajoCandado` (su estado y la base de su saldo). */
type VentaParaCobrada = OrderAmountsForBalance & { paymentStatus: string | null; customerId: string | null }

/**
 * 🔴 R11-2 (ronda 11; Codex recheck-15 #2): la decisión «A» con el DINERO real, bajo el candado de quien liga. «Ya cobrada» =
 * cerrada por estado (`esVentaYaCobrada`) o con cobros capturados (COMPLETED, sin los reembolsos: `computeOrderBalance`, la misma
 * regla de saldo de los cobros) que ya cubren su total. La ventana que cierra: la terminal captura $100, la finalización falla y
 * la venta se queda PENDING hasta que la recuperan (reenvío o barrido); si COCINA (`orders:update` sin `payments:create`) liga a un
 * cliente en esa ventana, ya no queda primario y la recuperación no le da sello ni puntos. Sin cobro (> $0) no hay «ya cobrada»: una
 * cortesía total sin pagos sigue abierta. `null` = la venta no es de este negocio. `leida`: la venta que quien llama YA leyó
 * bajo ese mismo candado (con estos campos), para no leerla dos veces.
 */
export async function ventaYaCobradaBajoCandado(
  tx: Pick<Prisma.TransactionClient, 'order' | 'payment'>,
  venta: { venueId: string; orderId: string },
  leida?: VentaParaCobrada,
): Promise<{
  paymentStatus: string | null
  customerId: string | null
  cobrada: boolean
  /** Lo que falta por cobrar (0 si está cerrada por estado). Cuentas fuera del plano, 23-oct. */
  pendiente: Prisma.Decimal
} | null> {
  const orden: VentaParaCobrada | null =
    leida ??
    (await tx.order.findFirst({
      where: { id: venta.orderId, venueId: venta.venueId },
      select: {
        paymentStatus: true,
        customerId: true,
        status: true,
        subtotal: true,
        discountAmount: true,
        serviceChargeAmount: true,
        contratoDePrecio: true,
        taxAmount: true,
      },
    }))
  if (!orden) return null
  const base = { paymentStatus: orden.paymentStatus ?? null, customerId: orden.customerId ?? null }
  if (esVentaYaCobrada(orden)) return { ...base, cobrada: true, pendiente: new Prisma.Decimal(0) }
  // Una suma, no la lista de cobros: los REFUND fuera (con `type` NULL dentro, como `COBRO_QUE_CUBRE`); la propina se cancela a
  // los dos lados del saldo.
  const cobrado = await tx.payment.aggregate({
    where: { orderId: venta.orderId, venueId: venta.venueId, status: 'COMPLETED', OR: [{ type: null }, { type: { not: 'REFUND' } }] },
    _sum: { amount: true, tipAmount: true },
  })
  const saldo = computeOrderBalance(orden, [{ amount: cobrado._sum.amount, tipAmount: cobrado._sum.tipAmount }])
  return {
    ...base,
    cobrada: saldo.paidAmount.greaterThan(0) && saldo.isFullyPaid,
    pendiente: saldo.remainingBalance,
  }
}

/**
 * ¿Hay un reembolso COMPLETED de esta venta? Conteo EXACTO, sin lista con tope (auditoría A #2). Lo usa la lealtad tardía para decir
 * `NOT_PAID` (una venta con dinero devuelto no da sello). NO decide «cobrada» (R7-2).
 *
 * Cambio de producto (spec 2026-10-20 §7.7): las devoluciones que escribe un cambio —el gemelo del crédito y la diferencia
 * devuelta— no cuentan: un cambio no le quita el sello a la venta original. La cadena y los reembolsos de siempre sí. Sigue
 * siendo UN conteo: lo que cuenta se nombra en la misma sentencia (`WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO`, NULL-safe).
 */
export async function ventaTieneReembolso(
  db: Pick<Prisma.TransactionClient, 'payment'>,
  venta: { venueId: string; orderId: string },
): Promise<boolean> {
  const reembolsos = await db.payment.count({
    where: {
      orderId: venta.orderId,
      venueId: venta.venueId,
      type: 'REFUND',
      status: 'COMPLETED',
      AND: [WHERE_DEVOLUCION_NO_ES_DEL_CAMBIO],
    },
  })
  return reembolsos > 0
}

export const MENSAJE_CLIENTE_DE_VENTA_COBRADA =
  'Para cambiar el cliente de una venta ya cobrada necesitas el permiso de cobrar. Pídeselo a tu administrador.'
export const CODIGO_CLIENTE_DE_VENTA_COBRADA = 'CUSTOMER_CHANGE_REQUIRES_PAYMENTS_CREATE'

/**
 * 🔴 R4-2 (ronda 4 post-QA de sellos tardíos; decisión «A» del founder): `Order.customerId` es el respaldo heredado de la
 * lealtad — en una venta pagada con la lealtad pendiente y SIN primario, el reconciliador premia a ese cliente. Por eso, en una
 * venta COBRADA (`esVentaYaCobrada`), CAMBIAR el cliente (ponerlo donde no había, cambiarlo por otro o quitarlo) exige
 * `payments:create`; sin él ⇒ 403 en español y quien llama no guarda NADA de esa petición. El mismo cliente que ya tiene, una
 * venta abierta o quien tiene el permiso ⇒ pasa. Lo usan los editores genéricos de la venta que devuelven el `customerId`
 * guardado (el PUT del panel y el «detalle de la cuenta» del POS): ignorarlo en silencio haría que la pantalla dijera
 * «guardado» con el cliente viejo. Quien llama lo decide con lo que leyó BAJO el candado de la venta.
 */
export function asegurarCambioDeClienteEnVentaCobrada(args: {
  /** R11-2: el veredicto de `ventaYaCobradaBajoCandado` (estado cerrado o cobros que ya la cubren). */
  cobrada: boolean
  clienteActual: string | null
  clienteNuevo: string | null
  puedeCobrar: boolean
}): void {
  if (args.clienteNuevo === args.clienteActual) return
  if (!args.cobrada) return
  if (args.puedeCobrar) return
  throw new ForbiddenError(MENSAJE_CLIENTE_DE_VENTA_COBRADA, CODIGO_CLIENTE_DE_VENTA_COBRADA)
}

/**
 * R4-2: la misma regla, leyendo la venta con `tx` — la usan el «detalle de la cuenta» del POS (también el MCP y el intent
 * `UPDATE_DETAILS`) y el PUT del panel. Quien llama YA tomó el candado de la venta en esa transacción; la lectura de aquí es la
 * vigente (R11-2: con los cobros que ya la cubren). Con el permiso no lee nada. Si la venta no está (no es de este negocio), no
 * decide: quien llama ya responde 404.
 */
export async function asegurarCambioDeClienteBajoCandado(
  tx: Pick<Prisma.TransactionClient, 'order' | 'payment'>,
  args: { venueId: string; orderId: string; clienteNuevo: string | null; puedeCobrar: boolean },
): Promise<void> {
  if (args.puedeCobrar) return
  const venta = await ventaYaCobradaBajoCandado(tx, args)
  if (!venta) return
  asegurarCambioDeClienteEnVentaCobrada({
    cobrada: venta.cobrada,
    clienteActual: venta.customerId,
    clienteNuevo: args.clienteNuevo,
    puedeCobrar: false,
  })
}
