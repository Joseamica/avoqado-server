// src/services/online-ordering/printClaim.service.ts
import { OnlineOrderPaymentMode, OnlineOrderStatus, type Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { PRINT_CLAIM_TTL_MS } from './constants'

const PRINTABLE: OnlineOrderStatus[] = [OnlineOrderStatus.ACCEPTED, OnlineOrderStatus.READY]
/** D661: pedido con tarjeta de «Nadie» (`CARD_ONLINE` sin aceptación). */
const D661 = { paymentMode: OnlineOrderPaymentMode.CARD_ONLINE, requiresAcceptance: false } as const
/**
 * D661 (Ruling 2): lo que `comandasPorImprimir` mira hacia atrás. Lo ya cobrado sale de «Por entregar» a lo más con el cierre del día,
 * así que basta para no perder la comanda de lo que se cobró justo antes del corte, y acota la lectura al índice `[venueId, createdAt]`.
 * ponytail: un pedido cuya comanda siga sin salir 24 h después ya no se lista (sigue reclamable); ampliar si una caja pasa días sin papel.
 */
const VENTANA_DE_COMANDAS_MS = 24 * 3_600_000

/**
 * Qué pedido admite comanda: aceptado o listo, y (D661, Ruling 2) un pedido con tarjeta de «Nadie» que el cierre del día ya pasó a
 * COMPLETED; sin papel confirmado, sin devolución reservada ni hecha, y libre o con un reclamo vencido (se prefiere imprimir de más,
 * que molesta, a no imprimir, que la cocina no se entera; sin «soltar», R20). La MISMA regla para la lista, el reclamo y `needsPrint`.
 */
const comandaPendienteWhere = (now: Date) =>
  ({
    printedAt: null,
    refundRequestedAt: null,
    refundedAt: null,
    AND: [
      { OR: [{ status: { in: PRINTABLE } }, { status: OnlineOrderStatus.COMPLETED, ...D661 }] },
      { OR: [{ printClaimedAt: null }, { printClaimedAt: { lt: new Date(now.getTime() - PRINT_CLAIM_TTL_MS) } }] },
    ],
  }) satisfies Prisma.OnlineOrderWhereInput

/** ¿Este pedido todavía necesita que ALGUIEN imprima la comanda? Un reclamo vencido cuenta como libre. */
export function onlineOrderNeedsPrint(
  o: {
    status: OnlineOrderStatus
    printedAt: Date | null
    printClaimedAt: Date | null
    // Obligatorios: quien llame sin ellos se apartaría en silencio de la regla de la lista y del reclamo (D661, Ruling 2).
    paymentMode: OnlineOrderPaymentMode
    requiresAcceptance: boolean
    refundRequestedAt: Date | null
    refundedAt: Date | null
  },
  now: Date = new Date(),
): boolean {
  const cerradoD661 = o.status === OnlineOrderStatus.COMPLETED && o.paymentMode === D661.paymentMode && o.requiresAcceptance === false
  if (!PRINTABLE.includes(o.status) && !cerradoD661) return false
  if (o.printedAt || o.refundRequestedAt || o.refundedAt) return false
  if (!o.printClaimedAt) return true
  return o.printClaimedAt.getTime() < now.getTime() - PRINT_CLAIM_TTL_MS
}

/**
 * D661 (Ruling 2): `comandasPorImprimir` de la lista de la caja: los pedidos con tarjeta de «Nadie» ya cobrados cuya comanda nadie ha
 * impreso (también los que el cierre del día pasó a COMPLETED), sin devolución. Independiente de la página de «Por entregar».
 */
export const comandasPorImprimirWhere = (venueId: string, now: Date) => ({
  venueId,
  ...D661,
  createdAt: { gte: new Date(now.getTime() - VENTANA_DE_COMANDAS_MS) },
  ...comandaPendienteWhere(now),
})

/**
 * «Yo la imprimo.» Lee el reclamo vigente y gana con un CAS sobre ESE valor: si otro aparato lo tomó entre la lectura y la escritura,
 * pierde. Ruling 9 («al menos una vez»): si gana sobre un reclamo anterior que venció sin confirmarse, ese papel pudo haber salido:
 * `posibleRepetida: true` para que la caja lo marque. No se le pregunta nada a la cajera.
 */
export async function claimOnlineOrderPrint(
  venueId: string,
  orderId: string,
  deviceId: string,
  now: Date = new Date(),
): Promise<{ claimed: boolean; posibleRepetida?: true }> {
  const where = { orderId, venueId, ...comandaPendienteWhere(now) }
  const previo = await prisma.onlineOrder.findFirst({ where, select: { printClaimedAt: true } })
  if (!previo) return { claimed: false }
  const r = await prisma.onlineOrder.updateMany({
    where: { ...where, printClaimedAt: previo.printClaimedAt },
    data: { printClaimedAt: now, printClaimedBy: deviceId },
  })
  if (r.count === 0) return { claimed: false }
  return previo.printClaimedAt ? { claimed: true, posibleRepetida: true } : { claimed: true }
}

/** «Ya salió el papel.» Sólo lo confirma quien lo reclamó. */
export async function confirmOnlineOrderPrinted(
  venueId: string,
  orderId: string,
  deviceId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean }> {
  const r = await prisma.onlineOrder.updateMany({
    where: { orderId, venueId, printClaimedBy: deviceId, printedAt: null },
    data: { printedAt: now },
  })
  return { ok: r.count > 0 }
}
