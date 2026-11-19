import type { Prisma } from '@prisma/client'
import { AUTO_PAUSE_AFTER_MISSED } from './constants'

type Tx = Pick<Prisma.TransactionClient, 'onlineOrderingSettings'>

/**
 * D662 (founder, 18-nov, «como Uber Eats»): un pedido de «Mi equipo» acaba de vencer. Va DENTRO de la transacción del vencimiento,
 * después de su CAS (un intento abortado no cuenta nada). El `+1` toma el candado de la fila de ajustes, y la respuesta de una
 * persona (`reiniciarPedidosSinAtenderEnTx`) escribe la misma fila dentro de SU transacción: el orden de ese candado es el orden de
 * los hechos. Sólo cuenta con la tienda encendida y en «Mi equipo». Al llegar a [AUTO_PAUSE_AFTER_MISSED] la tienda se pausa sola y
 * la cuenta vuelve a 0; si ya tenía otra pausa indefinida (la sola o la del gerente) sólo vuelve a 0. Una pausa del piso de 15/30/60
 * min no la evita: esos pedidos también se quedaron sin respuesta. Devuelve `true` si con ESTE pedido se pausó.
 */
export async function contarPedidoSinAtenderEnTx(tx: Tx, venueId: string, now: Date): Promise<boolean> {
  const contado = await tx.onlineOrderingSettings.updateMany({
    where: { venueId, enabled: true, requiresAcceptance: true },
    data: { missedOrdersInARow: { increment: 1 } },
  })
  if (!contado?.count) return false
  // La fila ya está bloqueada por el UPDATE de arriba hasta el commit: esta lectura y la escritura de abajo no compiten con nadie.
  const s = await tx.onlineOrderingSettings.findUnique({
    where: { venueId },
    select: { missedOrdersInARow: true, autoPausedAt: true, manualPause: true },
  })
  if (!s || s.missedOrdersInARow < AUTO_PAUSE_AFTER_MISSED) return false
  const pausa = !s.autoPausedAt && !s.manualPause
  await tx.onlineOrderingSettings.update({ where: { venueId }, data: { missedOrdersInARow: 0, ...(pausa ? { autoPausedAt: now } : {}) } })
  return pausa
}

/**
 * Una PERSONA contestó a tiempo un pedido de «Mi equipo» (aceptó o rechazó desde la caja, la TPV, el panel o el MCP): la cuenta vuelve
 * a 0. Va DENTRO de la transacción de su toque, nunca después: así no borra un vencimiento que se confirme más tarde. Los caminos del
 * sistema (aviso de Stripe, conciliador, captura tardía, barridos, folios de «Nadie») no la llaman.
 */
export async function reiniciarPedidosSinAtenderEnTx(tx: Tx, venueId: string): Promise<void> {
  await tx.onlineOrderingSettings.updateMany({ where: { venueId, missedOrdersInARow: { gt: 0 } }, data: { missedOrdersInARow: 0 } })
}
