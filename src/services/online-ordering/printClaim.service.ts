// src/services/online-ordering/printClaim.service.ts
import { OnlineOrderPaymentMode, OnlineOrderStatus, type Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { PRINT_CLAIM_TTL_MS } from './constants'

const PRINTABLE: OnlineOrderStatus[] = [OnlineOrderStatus.ACCEPTED, OnlineOrderStatus.READY]
/**
 * D661: el «Entregado» al que el cierre del día pasa un pedido de «Nadie». Se LEE en lista (`status: { in: … }`), como toda lectura de
 * COMPLETED en `src/`: `status: OnlineOrderStatus.COMPLETED` es la forma de una ESCRITURA y la vigila `escritoresDeEntregado`.
 */
const CLOSED_BY_DAY_END: OnlineOrderStatus[] = [OnlineOrderStatus.COMPLETED]
/** D661: pedido con tarjeta de «Nadie» (`CARD_ONLINE` sin aceptación). */
const D661 = { paymentMode: OnlineOrderPaymentMode.CARD_ONLINE, requiresAcceptance: false } as const
/**
 * D661 (Ruling 2): lo que `comandasPorImprimir` mira hacia atrás. Lo ya cobrado sale de «Por entregar» a lo más con el cierre del día,
 * así que basta para no perder la comanda de lo que se cobró justo antes del corte, y acota la lectura al índice `[venueId, createdAt]`.
 * ponytail: un pedido cuya comanda siga sin salir 24 h después ya no se lista (sigue reclamable); ampliar si una caja pasa días sin papel.
 */
const VENTANA_DE_COMANDAS_MS = 24 * 3_600_000
/**
 * D661 (B2, Ruling 31): un «No lo recogió» admite comanda sólo estas horas tras el corte. Conserva el borde para el que nació la regla
 * (lo abierto minutos antes del corte) sin que la comanda que nunca salió se imprima a la mañana siguiente para un pedido que nadie
 * va a recoger. ponytail: con la impresora caída más de 2 h esa comanda ya no sale; el pedido sigue a la vista en el panel.
 */
export const NO_LO_RECOGIO_PAPEL_MS = 2 * 3_600_000

/**
 * Qué pedido admite comanda: aceptado o listo, y (D661, Ruling 2) un pedido con tarjeta de «Nadie» que el cierre del día ya pasó a
 * COMPLETED (B2: sólo durante `NO_LO_RECOGIO_PAPEL_MS` tras el corte); sin papel confirmado, sin devolución reservada ni hecha, y
 * libre o con un reclamo vencido (se prefiere imprimir de más, que molesta, a no imprimir, que la cocina no se entera; sin «soltar»,
 * R20). La MISMA regla para la lista, el reclamo, `needsPrint` y (B3) la devolución (`comandaAdmitida`).
 * D661 (Task 4): de lo COMPLETED, sólo lo que cerró el corte («No lo recogió», `notPickedUpAt`): lo que una PERSONA marcó
 * «Entregado» sin que saliera su papel ya se entregó y no pide comanda.
 */
const comandaPendienteWhere = (now: Date) =>
  ({
    printedAt: null,
    refundRequestedAt: null,
    refundedAt: null,
    AND: [
      {
        OR: [
          { status: { in: PRINTABLE } },
          { status: { in: CLOSED_BY_DAY_END }, ...D661, notPickedUpAt: { gte: new Date(now.getTime() - NO_LO_RECOGIO_PAPEL_MS) } },
        ],
      },
      { OR: [{ printClaimedAt: null }, { printClaimedAt: { lt: new Date(now.getTime() - PRINT_CLAIM_TTL_MS) } }] },
    ],
  }) satisfies Prisma.OnlineOrderWhereInput

/** Lo que la regla del papel lee de un pedido. Todo obligatorio: quien llame sin un campo se apartaría en silencio de la regla. */
interface PedidoDelPapel {
  status: OnlineOrderStatus
  printedAt: Date | null
  paymentMode: OnlineOrderPaymentMode
  requiresAcceptance: boolean
  notPickedUpAt: Date | null
  refundRequestedAt: Date | null
  refundedAt: Date | null
}

/**
 * D661 (B3): la MISMA regla sin el reclamo: ¿este pedido admite comanda (aunque alguien la esté imprimiendo ahora)? La usa la
 * devolución: si la admite, un reclamo vigente la frena (`PRINT_IN_FLIGHT`) y, si no hay, la reserva la saca de la regla.
 */
export function comandaAdmitida(o: PedidoDelPapel, now: Date = new Date()): boolean {
  const cerradoD661 =
    o.status === OnlineOrderStatus.COMPLETED &&
    o.paymentMode === D661.paymentMode &&
    o.requiresAcceptance === false &&
    o.notPickedUpAt != null &&
    o.notPickedUpAt.getTime() >= now.getTime() - NO_LO_RECOGIO_PAPEL_MS
  if (!PRINTABLE.includes(o.status) && !cerradoD661) return false
  return !o.printedAt && !o.refundRequestedAt && !o.refundedAt
}

/** ¿Este pedido todavía necesita que ALGUIEN imprima la comanda? Un reclamo vencido cuenta como libre. */
export function onlineOrderNeedsPrint(o: PedidoDelPapel & { printClaimedAt: Date | null }, now: Date = new Date()): boolean {
  if (!comandaAdmitida(o, now)) return false
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
