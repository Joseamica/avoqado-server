import { OnlineOrderStatus } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import type { TxConReintento } from '@/utils/serializableRetry'
import { AUTO_PAUSE_AFTER_MISSED } from './constants'

/**
 * D662 (founder, 18-nov, «como Uber Eats»): un pedido de «Mi equipo» acaba de vencer. Va DENTRO de la transacción del vencimiento
 * (un intento abortado no cuenta nada) y DESPUÉS de su CAS (el pedido ya está EXPIRED). Cuenta los vencidos de «Mi equipo» desde
 * `missedOrdersSince`; con [AUTO_PAUSE_AFTER_MISSED] la tienda se pausa sola y la cuenta vuelve a empezar. Sólo con la tienda
 * encendida y en «Mi equipo», y sin otra pausa indefinida (la sola o la del gerente); una pausa del piso de 15/30/60 min no la evita:
 * esos pedidos también se quedaron sin respuesta. Devuelve `true` si con ESTE pedido se pausó.
 *
 * Candados, siempre en este orden: la orden (el CAS) → la fila de ajustes → la admisión de pedidos (sólo al pausar). La admisión
 * vuelve a leer la pausa bajo su candado, así que un pedido que ya se estaba cotizando no entra después de la pausa.
 */
export async function contarPedidoSinAtenderEnTx(tx: TxConReintento, venueId: string, now: Date): Promise<boolean> {
  // Candado de la fila de ajustes: otro vencimiento a la vez, una respuesta o «Reanudar» quedan en orden contra esta lectura.
  const fila = await tx.onlineOrderingSettings.updateMany({
    where: { venueId, enabled: true, requiresAcceptance: true },
    data: { updatedAt: now },
  })
  if (!fila?.count) return false
  const s = await tx.onlineOrderingSettings.findUnique({
    where: { venueId },
    select: { missedOrdersSince: true, autoPausedAt: true, manualPause: true },
  })
  if (!s || s.autoPausedAt || s.manualPause) return false
  if (!s.missedOrdersSince) {
    // Primera vez que se cuenta (fila de antes de D662): la cuenta empieza con ESTE pedido; lo vencido antes no pausa a nadie.
    await tx.onlineOrderingSettings.update({ where: { venueId }, data: { missedOrdersSince: new Date(now.getTime() - 1) } })
    return false
  }
  const vencidos = await tx.onlineOrder.count({
    where: { venueId, requiresAcceptance: true, status: OnlineOrderStatus.EXPIRED, expiredAt: { gt: s.missedOrdersSince } },
  })
  if (vencidos < AUTO_PAUSE_AFTER_MISSED) return false
  // Dinámico: `order.service` importa la máquina de estados que llama aquí.
  const { lockAdmission } = await import('./order.service')
  await lockAdmission(tx, venueId)
  await tx.onlineOrderingSettings.update({ where: { venueId }, data: { autoPausedAt: now, missedOrdersSince: now } })
  return true
}

/**
 * Una PERSONA contestó un pedido de «Mi equipo» (aceptar o rechazar en la bandeja, el panel o el MCP): lo vencido antes de `at` ya
 * no cuenta. Se llama al recibir el toque, ANTES de la transición (aceptar con tarjeta espera a Stripe). Sólo mueve la marca hacia
 * adelante, así que una escritura tardía nunca borra un vencimiento posterior. Los caminos del sistema (aviso de Stripe, conciliador,
 * captura tardía, barridos) no la llaman. Nunca tumba a quien llama.
 */
export async function marcarPedidoAtendido(venueId: string, at: Date = new Date()): Promise<void> {
  try {
    await prisma.onlineOrderingSettings.updateMany({
      where: { venueId, OR: [{ missedOrdersSince: null }, { missedOrdersSince: { lt: at } }] },
      data: { missedOrdersSince: at },
    })
  } catch (error) {
    logger.warn('[OnlineOrdering] no se pudo marcar la respuesta del personal (pausa sola)', { venueId, error })
  }
}
