// src/services/online-ordering/printClaim.service.ts
import { OnlineOrderStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { PRINT_CLAIM_TTL_MS } from './constants'

const PRINTABLE: OnlineOrderStatus[] = [OnlineOrderStatus.ACCEPTED, OnlineOrderStatus.READY]

/**
 * ¿Este pedido todavía necesita que ALGUIEN imprima la comanda? Un reclamo vencido cuenta como libre: se prefiere imprimir de
 * más (molesta) a no imprimir (la cocina no se entera). Sin «soltar» (R20): el TTL libera solo.
 */
export function onlineOrderNeedsPrint(
  o: { status: OnlineOrderStatus; printedAt: Date | null; printClaimedAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!PRINTABLE.includes(o.status)) return false
  if (o.printedAt) return false
  if (!o.printClaimedAt) return true
  return o.printClaimedAt.getTime() < now.getTime() - PRINT_CLAIM_TTL_MS
}

/** «Yo la imprimo.» Un `updateMany` atómico: gana quien la base deja pasar primero. */
export async function claimOnlineOrderPrint(
  venueId: string,
  orderId: string,
  deviceId: string,
  now: Date = new Date(),
): Promise<{ claimed: boolean }> {
  const limit = new Date(now.getTime() - PRINT_CLAIM_TTL_MS)
  const r = await prisma.onlineOrder.updateMany({
    where: {
      orderId,
      venueId,
      status: { in: PRINTABLE },
      printedAt: null,
      OR: [{ printClaimedAt: null }, { printClaimedAt: { lt: limit } }],
    },
    data: { printClaimedAt: now, printClaimedBy: deviceId },
  })
  return { claimed: r.count > 0 }
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
