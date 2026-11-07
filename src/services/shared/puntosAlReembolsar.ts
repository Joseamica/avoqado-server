import { LoyaltyTransactionType, PaymentType, Prisma } from '@prisma/client'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { PRESUPUESTO_DE_LA_LEALTAD_DE_LA_VENTA } from '@/services/dashboard/loyalty.dashboard.service'
import { EXCHANGE_REFUND_ROLE, WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT, origenEconomicoDeDevolucion } from '@/services/exchanges/exchangeMarks'
import prisma from '@/utils/prismaClient'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'

/**
 * D6 (5-nov-2026): al reembolsar una venta, el cliente pierde los puntos que ganó con ella (la regla de Square, help 6130).
 *
 * Es un LIBRO: el EARN se queda y nace un ADJUST negativo por cada reembolso, con su `refundPaymentId` (índice único: una reversa por
 * reembolso, aunque el efecto se repita). Corre como efecto durable (`LOYALTY_POINTS_REVERSAL`, nace en la transacción del reembolso) y
 * toma el MISMO candado de la venta que `earnPoints`: o el otorgamiento ve el reembolso y no otorga, o esto ve los puntos y los quita.
 *
 * Un reembolso de antes de publicar esto no tiene fila ni efecto: no cuenta y no se le quitan puntos a nadie por él.
 */

const PAGINA_DE_DEVOLUCIONES_DEL_CAMBIO = 100

/**
 * Cuántos puntos de la venta se pierden con `devuelto` pesos (acumulado, sin propina) de los `cobrado` que dieron puntos.
 * Completo: todos, bono incluido. Parcial: el bono se queda y se conserva `floor(gasto × lo que queda / cobrado)`, así que varios
 * parciales suman lo mismo que uno solo y nunca más de lo ganado. Entera con `dividedToIntegerBy`: sin el error de los flotantes.
 */
export function puntosPerdidos(a: { ganados: number; bono: number; cobrado: Prisma.Decimal; devuelto: Prisma.Decimal }): number {
  if (a.cobrado.lte(0)) return 0
  if (a.devuelto.gte(a.cobrado)) return a.ganados
  const gasto = a.ganados - a.bono
  return gasto - new Prisma.Decimal(gasto).times(a.cobrado.minus(a.devuelto)).dividedToIntegerBy(a.cobrado).toNumber()
}

const pesos = (d: Prisma.Decimal) => `$${d.toFixed(2)}`

/** El importe que dio los puntos de un EARN de antes de D6: lo escribe su motivo desde que existe la lealtad (nov-2025). */
function baseDelMotivo(reason: string | null): Prisma.Decimal | null {
  const importe = reason?.match(/for purchase of \$(\d+(?:\.\d+)?)$/)?.[1]
  return importe ? new Prisma.Decimal(importe) : null
}

type Devolucion = { id: string; amount: Prisma.Decimal; processedById: string | null }

/** Lo que `processorData` dice del cambio al que pertenece la devolución. */
const marcaDelCambio = (processorData: Prisma.JsonValue) =>
  (processorData as { exchange?: { role?: unknown; rootPaymentId?: unknown } } | null)?.exchange

/**
 * La reversa de UNA devolución. Quien llama ya tiene el candado de la venta. Sin puntos en esa venta, o con su reversa ya escrita, no
 * hace nada.
 */
async function reversaEnTx(tx: TxConReintento, venueId: string, orderId: string, devolucion: Devolucion) {
  const earn = await tx.loyaltyTransaction.findFirst({
    where: { orderId, type: LoyaltyTransactionType.EARN, customer: { venueId } },
    orderBy: { createdAt: 'asc' },
    select: {
      customerId: true,
      points: true,
      visitBonusPoints: true,
      baseAmount: true,
      reason: true,
      order: { select: { orderNumber: true } },
    },
  })
  if (!earn) return null
  if (await tx.loyaltyTransaction.findUnique({ where: { refundPaymentId: devolucion.id }, select: { id: true } })) return null

  // Lo devolvible: lo cobrado en la venta, sin propina (`amount` no la trae) y sin el crédito de un cambio, que dio puntos en su raíz.
  const pagado = (
    await tx.payment.aggregate({
      where: {
        orderId,
        venueId,
        status: { in: ['COMPLETED', 'REFUNDED'] }, // `REFUNDED`: cobros viejos marcados al devolverse; ya nada lo escribe
        AND: [{ OR: [{ type: null }, { type: { not: PaymentType.REFUND } }] }, WHERE_PAYMENT_IS_NOT_EXCHANGE_CREDIT],
      },
      _sum: { amount: true },
    })
  )._sum.amount
  // 🔴 La base es la MENOR entre lo que dio puntos y lo devolvible. Casi siempre son iguales; un pago manual las separa (Codex r3 y r4):
  // con descuento el cobro guarda más de lo que dio puntos (devolver lo pagado de verdad tiene que ser «completo»), y con IVA guarda menos
  // (devolver todo lo devolvible también). Lo que dio puntos lo guarda el EARN desde D6; uno de antes lo dice en su motivo.
  const cobrado = [earn.baseAmount ?? baseDelMotivo(earn.reason), pagado]
    .filter((d): d is Prisma.Decimal => !!d?.gt(0))
    .reduce<Prisma.Decimal | null>((menor, d) => (menor === null || d.lt(menor) ? d : menor), null)
  // Lo ya procesado: lo devuelto por las reversas anteriores de esta venta. Se cuenta lo que TOCABA, no lo que se pudo quitar: lo que un
  // cliente ya había gastado se perdona, nunca se le cobra después de sus puntos nuevos.
  const [previo] = await tx.$queryRaw<Array<{ devuelto: Prisma.Decimal | null }>>`
    SELECT SUM(ABS(p."amount")) AS devuelto FROM "LoyaltyTransaction" lt
    JOIN "Payment" p ON p.id = lt."refundPaymentId" AND p."venueId" = ${venueId}
    WHERE lt."orderId" = ${orderId}`
  const devueltoAntes = new Prisma.Decimal(previo?.devuelto ?? 0)
  const devuelto = devueltoAntes.plus(devolucion.amount.abs())
  const base = { ganados: earn.points, bono: earn.visitBonusPoints ?? 0, cobrado: cobrado ?? new Prisma.Decimal(0) }
  if (base.cobrado.lte(0))
    logger.error('[LEALTAD] venta con puntos y sin cobros legibles: no se quitan', { venueId, orderId, refundPaymentId: devolucion.id })
  const tocaba = puntosPerdidos({ ...base, devuelto }) - puntosPerdidos({ ...base, devuelto: devueltoAntes })

  // 🔴 La venta ANTES que el cliente, como el reembolso y `earnPoints`. La fila de abajo liga la venta (su llave foránea pide `FOR KEY SHARE`):
  // si se pidiera con el cliente ya tomado, un reembolso que tiene la venta y le abre su primer saldo a favor (llave foránea al cliente)
  // se cruzaría con esto, y Postgres podría abortar el reembolso.
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} AND "venueId" = ${venueId} FOR KEY SHARE`
  const [cliente] = await tx.$queryRaw<Array<{ loyaltyPoints: number }>>`
    SELECT "loyaltyPoints" FROM "Customer" WHERE id = ${earn.customerId} AND "venueId" = ${venueId} FOR UPDATE`
  const saldo = Math.max(0, cliente?.loyaltyPoints ?? 0)
  const quitados = Math.min(tocaba, saldo)

  const venta = `la venta ${earn.order?.orderNumber ?? orderId}`
  const completo = devuelto.gte(base.cobrado) && base.cobrado.gt(0)
  const reason =
    (completo
      ? `Reembolso completo de ${venta}`
      : `Reembolso parcial de ${venta} (devuelto ${pesos(devuelto)} de ${pesos(base.cobrado)})`) +
    (tocaba === 0
      ? ': los puntos no cambian'
      : quitados < tocaba
        ? `: tocaba quitar ${tocaba} puntos, pero el cliente sólo tenía ${saldo}: ya había usado el resto`
        : `: se quitan ${quitados} puntos`)
  const staffVenue = devolucion.processedById
    ? await tx.staffVenue.findFirst({ where: { staffId: devolucion.processedById, venueId }, select: { id: true } })
    : null
  await tx.loyaltyTransaction.create({
    data: {
      customerId: earn.customerId,
      type: LoyaltyTransactionType.ADJUST,
      points: -quitados,
      orderId,
      reason,
      refundPaymentId: devolucion.id,
      createdById: staffVenue?.id,
    },
  })
  if (quitados > 0) await tx.customer.update({ where: { id: earn.customerId }, data: { loyaltyPoints: { decrement: quitados } } })
  return { customerId: earn.customerId, tocaba, quitados, saldoFinal: saldo - quitados }
}

/**
 * ¿De qué venta salen los puntos? De la que dio los puntos por ese dinero: la orden de la devolución, salvo en lo pagado con crédito de
 * un cambio, cuyo dinero (y sus puntos) son de la venta de la RAÍZ (`origenEconomicoDeDevolucion`, spec 2026-10-20 §6.7).
 */
async function ventaDeLosPuntos(venueId: string, refund: { orderId: string; processorData: Prisma.JsonValue }): Promise<string> {
  // La marca del cambio trae SIEMPRE la raíz; la llave suelta `rootPaymentId` no siempre (la diferencia devuelta por otro medio no la lleva).
  const raiz = marcaDelCambio(refund.processorData)?.rootPaymentId
  const origen = typeof raiz === 'string' ? raiz : origenEconomicoDeDevolucion(refund.processorData)
  if (!origen) return refund.orderId
  const cobro = await prisma.payment.findFirst({ where: { id: origen, venueId }, select: { orderId: true } })
  return cobro?.orderId ?? refund.orderId
}

/** Idempotente y sin lanzar por no encontrar nada: la mayoría de las ventas devueltas no dieron puntos. Un error real lo reintenta el efecto. */
export async function quitarPuntosPorReembolso(venueId: string, refundPaymentId: string): Promise<void> {
  const refund = await prisma.payment.findFirst({
    where: { id: refundPaymentId, venueId, type: PaymentType.REFUND, status: 'COMPLETED' },
    select: { id: true, amount: true, orderId: true, processorData: true, processedById: true },
  })
  // Devolver sólo la propina no toca los puntos: la propina nunca los dio.
  if (!refund?.orderId || refund.amount.isZero()) return
  // El gemelo del crédito no es dinero que salió (un cambio parejo conserva sus puntos). Normalmente ni siquiera encola; por si acaso.
  if (marcaDelCambio(refund.processorData)?.role === EXCHANGE_REFUND_ROLE.CREDIT) return

  const orderId = await ventaDeLosPuntos(venueId, { orderId: refund.orderId, processorData: refund.processorData })
  const movimiento = await withDeadlockRetry(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${venueId}), hashtext(${orderId}))`
      return reversaEnTx(tx, venueId, orderId, refund)
    },
    { etiqueta: 'quitarPuntosPorReembolso', ...PRESUPUESTO_DE_LA_LEALTAD_DE_LA_VENTA },
  )
  if (!movimiento) return

  void logAction({
    staffId: refund.processedById,
    venueId,
    action: 'LOYALTY_POINTS_REVERSED_BY_REFUND',
    entity: 'Customer',
    entityId: movimiento.customerId,
    data: { orderId, refundPaymentId, tocaba: movimiento.tocaba, quitados: movimiento.quitados, saldoFinal: movimiento.saldoFinal },
  })
}

/**
 * Los puntos llegaron DESPUÉS de un cambio (el otorgamiento falló y lo terminó el reconciliador, o el cliente se ligó tarde): la reversa
 * de la diferencia devuelta o de la cadena ya corrió sin encontrar nada, y `ventaTieneReembolso` no frena el otorgamiento porque un cambio
 * no le quita la lealtad a la venta original. Esto las pone al corriente, en la MISMA transacción del EARN y bajo su candado, para que la
 * venta siga dando puntos sólo sobre lo que no regresó. Quien llama sólo entra si la venta tuvo un cambio: no es el camino de cada cobro.
 */
export async function quitarDevolucionesDelCambioEnTx(tx: TxConReintento, venueId: string, orderId: string): Promise<void> {
  // Por páginas y hasta que no quede ninguna: cada reversa escrita sale sola de la consulta (`NOT EXISTS`). Sin el gemelo del crédito ni
  // lo que sólo devolvió propina. La raíz, en SQL: lo devuelto en la venta nueva de un cambio también viene de los cobros de ésta.
  for (;;) {
    const pendientes = await tx.$queryRaw<Devolucion[]>`
      SELECT d.id, d.amount, d."processedById" FROM "Payment" d
      WHERE d."venueId" = ${venueId} AND d.type = 'REFUND' AND d.status = 'COMPLETED' AND d.amount <> 0
        AND d."processorData"->'exchange'->>'role' <> ${EXCHANGE_REFUND_ROLE.CREDIT}
        AND d."processorData"->'exchange'->>'rootPaymentId' IN (SELECT c.id FROM "Payment" c WHERE c."venueId" = ${venueId} AND c."orderId" = ${orderId})
        AND NOT EXISTS (SELECT 1 FROM "LoyaltyTransaction" lt WHERE lt."refundPaymentId" = d.id)
      ORDER BY d.id LIMIT ${PAGINA_DE_DEVOLUCIONES_DEL_CAMBIO}`
    if (pendientes.length === 0) return
    for (const d of pendientes) {
      // Sin EARN, nada que poner al corriente (y estas filas seguirían saliendo).
      if (!(await reversaEnTx(tx, venueId, orderId, d))) return
    }
  }
}
