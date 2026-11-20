// src/services/online-ordering/cardAlertPresence.ts
/**
 * D661: la caja ACTUALIZADA (TPV o POS) que sabe avisar los pedidos pagados en línea de «Nadie» late con su propia cabecera. Ese
 * latido es lo que deja prender `cardOnlineNadie` (7 días) y lo que hace que la tienda ofrezca tarjeta (15 min). Vive aparte de
 * `presence.service.ts` (D662): una caja vieja también late «por cobrar», pero no sabe avisar un pedido pagado.
 */
import prisma from '@/utils/prismaClient'
import { PRESENCE_WRITE_DEBOUNCE_MS } from './constants'

/** La caja que puede avisar los pedidos pagados en línea la manda con `1` (las rutas que la leen son de la tarea 3). */
export const CARD_ALERT_HEADER = 'x-online-orders-card-alert'

// En memoria a propósito (una sola instancia, sin Redis): amortigua la escritura; la verdad es la columna. Mapa PROPIO (R11): si
// compartiera el de los otros latidos, uno le «comería» el suyo al otro.
const lastWrite = new Map<string, number>()

export function __resetCardAlertPollDebounceForTests(): void {
  lastWrite.clear()
}

/**
 * Una caja capaz de avisar consultó ahora. Devuelve `true` si escribió. Como `touchInboxPoll`: la base se toca a lo más cada 30 s
 * por negocio, el amortiguador se mueve SÓLO si la escritura funcionó (R13) y sin fila de ajustes no hay nada que actualizar.
 */
export async function touchCardAlertPoll(venueId: string, now: Date = new Date()): Promise<boolean> {
  const last = lastWrite.get(venueId) ?? 0
  if (now.getTime() - last < PRESENCE_WRITE_DEBOUNCE_MS) return false
  await prisma.onlineOrderingSettings.updateMany({ where: { venueId }, data: { lastCardAlertPollAt: now } })
  lastWrite.set(venueId, now.getTime())
  return true
}
