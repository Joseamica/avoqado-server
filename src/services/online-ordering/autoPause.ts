import type { Prisma } from '@prisma/client'
import { AUTO_PAUSE_AFTER_MISSED } from './constants'

type Tx = Pick<Prisma.TransactionClient, 'onlineOrderingSettings'>

/**
 * D662 (founder, 18-nov, «como Uber Eats»): un pedido de «Mi equipo» se quedó sin atender (venció, o una persona lo rechazó después de
 * su hora límite). Va DENTRO de la transacción de esa transición y como su ÚLTIMA escritura (un intento abortado no cuenta nada; tomar
 * la fila de ajustes al final no cierra ciclos con cupones ni fichas de lealtad). Primero toma el candado de la fila; luego:
 * - si su hora LÍMITE fue antes de la última respuesta de una persona (`lastAnsweredAt`), ya no suma (Codex r7 #5: el barrido puede
 *   procesar juntos dos vencimientos que una aceptación a tiempo separó);
 * - si no, `+1`; con [AUTO_PAUSE_AFTER_MISSED] la tienda se pausa sola y la cuenta vuelve a 0. La pausa del gerente no la evita
 *   (Codex r7 #5/#7: al quitarla, la sola sigue hasta «Reanudar»); si ya estaba pausada sola, sólo vuelve a 0.
 * Sólo con la tienda encendida y en «Mi equipo». Devuelve `true` si con ESTE pedido se pausó.
 */
export async function contarPedidoSinAtenderEnTx(tx: Tx, venueId: string, pedido: { acceptDeadlineAt: Date }, now: Date): Promise<boolean> {
  const fila = await tx.onlineOrderingSettings.updateMany({
    where: { venueId, enabled: true, requiresAcceptance: true },
    data: { updatedAt: now },
  })
  if (!fila?.count) return false
  // La fila ya está bloqueada por el UPDATE de arriba hasta el commit: esta lectura y la escritura de abajo no compiten con nadie.
  const s = await tx.onlineOrderingSettings.findUnique({
    where: { venueId },
    select: { missedOrdersInARow: true, autoPausedAt: true, lastAnsweredAt: true },
  })
  if (!s) return false
  if (s.lastAnsweredAt && pedido.acceptDeadlineAt.getTime() <= s.lastAnsweredAt.getTime()) return false
  const n = s.missedOrdersInARow + 1
  if (n < AUTO_PAUSE_AFTER_MISSED) {
    await tx.onlineOrderingSettings.update({ where: { venueId }, data: { missedOrdersInARow: n } })
    return false
  }
  const pausa = !s.autoPausedAt
  await tx.onlineOrderingSettings.update({ where: { venueId }, data: { missedOrdersInARow: 0, ...(pausa ? { autoPausedAt: now } : {}) } })
  return pausa
}

/**
 * Una PERSONA contestó a tiempo un pedido de «Mi equipo» (aceptó o rechazó desde la caja, la TPV, el panel o el MCP) a la hora `at`:
 * la cuenta vuelve a 0 y `lastAnsweredAt` avanza. Va DENTRO de la transacción de su toque y como su ÚLTIMA escritura, nunca después
 * del commit. Escribe SIEMPRE (Codex r4 #1: así espera el candado de un `+1` sin confirmar). Los caminos del sistema (aviso de Stripe,
 * conciliador, captura tardía, barridos, folios de «Nadie») no la llaman.
 */
export async function reiniciarPedidosSinAtenderEnTx(tx: Tx, venueId: string, at: Date): Promise<void> {
  await tx.onlineOrderingSettings.updateMany({ where: { venueId }, data: { missedOrdersInARow: 0 } })
  await tx.onlineOrderingSettings.updateMany({
    where: { venueId, OR: [{ lastAnsweredAt: null }, { lastAnsweredAt: { lt: at } }] },
    data: { lastAnsweredAt: at },
  })
}
