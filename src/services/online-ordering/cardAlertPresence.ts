// src/services/online-ordering/cardAlertPresence.ts
/**
 * D661: la caja ACTUALIZADA (TPV o POS) que sabe avisar los pedidos pagados en línea de «Nadie» late con su propia cabecera. Vive
 * aparte de `presence.service.ts` (D662): una caja vieja también late «por cobrar», pero no sabe avisar un pedido pagado.
 * Ruling 7: dos columnas. `lastCardAlertPollAt` = cualquier sondeo de una caja capaz; sólo deja PRENDER `cardOnlineNadie` (7 días).
 * `cardAlertFastPollAt` = la caja recibió una respuesta RÁPIDA; es lo que hace que la tienda ofrezca tarjeta (90 s).
 */
import prisma from '@/utils/prismaClient'
import { CARD_ALERT_WRITE_DEBOUNCE_MS } from './constants'

/** La caja que puede avisar los pedidos pagados en línea la manda con `1`. */
export const CARD_ALERT_HEADER = 'x-online-orders-card-alert'

// En memoria a propósito (una sola instancia, sin Redis): amortigua la escritura; la verdad son las columnas. Mapas PROPIOS (R11): si
// compartieran el de los otros latidos, uno le «comería» el suyo al otro. El rápido aparte: un sondeo lento no retrasa la tarjeta.
const lastWrite = new Map<string, number>()
const lastFastWrite = new Map<string, number>()

export function __resetCardAlertPollDebounceForTests(): void {
  lastWrite.clear()
  lastFastWrite.clear()
}

/**
 * Una caja capaz de avisar recibió ahora una respuesta de to-pay, rápida (`rapida`) o con la espera larga. Devuelve `true` si escribió.
 * La hora es SIEMPRE la del servidor. La base se toca a lo más cada 20 s por negocio (con sondeos de 30 s, cada uno escribe) y el
 * amortiguador se mueve SÓLO si de verdad se escribió una fila (R13); sin fila de ajustes no hay nada que actualizar (la crea antes
 * `touchToPayPoll`).
 * D661 (B1): una respuesta LENTA apaga `cardAlertFastPollAt` en seguida, sin amortiguado: desde ese momento la caja ya no sondea en
 * 30 s, así que la tienda deja de ofrecer la tarjeta hasta la siguiente respuesta rápida (que tampoco espera el amortiguado de antes).
 * La escritura es condicional: con la marca ya apagada no toca nada.
 */
export async function touchCardAlertPoll(venueId: string, rapida: boolean): Promise<boolean> {
  const now = new Date()
  if (!rapida) {
    const { count } = await prisma.onlineOrderingSettings.updateMany({
      where: { venueId, cardAlertFastPollAt: { not: null } },
      data: { cardAlertFastPollAt: null, lastCardAlertPollAt: now },
    })
    if (count > 0) {
      lastWrite.set(venueId, now.getTime())
      lastFastWrite.delete(venueId)
      return true
    }
  }
  const ultima = (rapida ? lastFastWrite : lastWrite).get(venueId) ?? 0
  if (now.getTime() - ultima < CARD_ALERT_WRITE_DEBOUNCE_MS) return false
  const { count } = await prisma.onlineOrderingSettings.updateMany({
    where: { venueId },
    data: { lastCardAlertPollAt: now, ...(rapida ? { cardAlertFastPollAt: now } : {}) },
  })
  if (count === 0) return false
  lastWrite.set(venueId, now.getTime())
  if (rapida) lastFastWrite.set(venueId, now.getTime())
  return true
}

/**
 * D661 · A (Ruling 79): la ruta de las apps contestó LENTO a una consulta que no anota latido de caja que avisa (sin la cabecera:
 * WINDOWS sin foco, la TPV cobrando o en su pantalla de bloqueo; o una sesión que no abre pedidos). Esa caja también se va a dormir
 * 600 s, así que la marca rápida se apaga igual, sin anotar que una caja que avisa sondeó (`lastCardAlertPollAt` no se toca). Lanza si
 * no pudo escribir: quien llama contesta entonces la cadencia rápida (Ruling 41).
 */
export async function apagarMarcaRapida(venueId: string): Promise<void> {
  const { count } = await prisma.onlineOrderingSettings.updateMany({
    where: { venueId, cardAlertFastPollAt: { not: null } },
    data: { cardAlertFastPollAt: null },
  })
  if (count > 0) lastFastWrite.delete(venueId) // B1: la siguiente respuesta rápida la vuelve a poner en seguida
}
