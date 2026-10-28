/**
 * Rappi fase 3 — el dueño desconecta su tienda desde el panel (o el MCP), sin nadie de por medio.
 *
 * Tres pasos, y NINGUNA transacción abierta mientras Rappi contesta:
 *   1. Revisar (sólo lecturas): del venue, de Rappi, ni PENDING ni recién conectada, la misma conexión que vio el dueño y sin
 *      pedidos en curso. DISABLED → OK idempotente sin avisar.
 *   2. Avisar a Rappi «no integrada».
 *   3. Cerrar en una transacción corta con la fila bloqueada: sólo escribe DISABLED si sigue ACTIVE/PAUSED y es la MISMA
 *      conexión. Así el cierre de un clic viejo nunca apaga una conexión nueva, y dos clics a la vez dejan un solo DISABLED.
 *
 * 🔴 Sin candados ni reservas a propósito (D3 = A, founder 25-oct): un pedido que el procesador alcanzó a leer ACTIVE entra al
 * POS aunque el corte llegue un instante después, como en el mercado (Deliverect sigue mandando pedidos días después de pedir
 * la baja). Por eso el procesador de pedidos, el job y `avisarIntegrada` no cambian. Residuos aceptados:
 * `docs/audit/2026-10-24-rappi-fase-3/rediseno-r5.md` (workspace).
 *
 * D1 (founder, «a»): si Rappi no contesta bien, NO se desconecta. D2 («a2»): con `forzar` (segundo toque explícito del panel)
 * se reintenta una vez y se desconecta igual, con la desconexión marcada como forzada en la bitácora.
 */
import { DeliveryChannelStatus, DeliveryProvider } from '@prisma/client'

import logger from '@/config/logger'
import AppError, { NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

import { type DeliveryChannelLinkSafe, SAFE_SELECT } from '../../core/deliveryChannelLink.service'
import { configComoObjeto } from '../../core/llavesDelSistema'
import { DeliveryWriteNotSentError } from '../../core/types'
import { rappiAdapter } from './rappi.adapter'
import { conexionIdDe, contarPedidosEnCurso } from './rappi.pedidosEnCurso'

export { conexionIdDe, contarPedidosEnCurso } from './rappi.pedidosEnCurso'

/**
 * Tras confirmar una conexión, el aviso «integrada sí» sale sin esperarlo (`rappi.provisioning.ts`, `avisarIntegrada`) y
 * puede tardar ~40 s (login 10 s + petición 10 s, dos veces si hay un 401). En ese minuto no se desconecta: así un «sí»
 * atrasado nunca llega a Rappi después de nuestro «no».
 */
export const VENTANA_TRAS_CONECTAR_MS = 60_000

export type ResultadoDesconectar = { link: DeliveryChannelLinkSafe; yaEstaba: boolean; forzada: boolean }

type Aviso = { ok: true; status: number } | { ok: false; tipo: 'NO_ACEPTO' | 'SIN_CONFIRMAR'; status?: number; detalle: string }

const conflicto = (code: string, message: string, details?: unknown) => new AppError(message, 409, true, code, details)

async function avisarNoIntegrada(storeId: string): Promise<Aviso> {
  try {
    const r = await rappiAdapter.notifyIntegrationStatus(storeId, false)
    if (r.ok) return { ok: true, status: r.status }
    return { ok: false, tipo: 'NO_ACEPTO', status: r.status, detalle: String(r.raw ?? '').slice(0, 300) }
  } catch (e) {
    const detalle = (e instanceof Error ? e.message : String(e)).slice(0, 300)
    // El candado de escritura o un token que no se pudo pedir: se SABE que Rappi no recibió nada.
    return { ok: false, tipo: e instanceof DeliveryWriteNotSentError ? 'NO_ACEPTO' : 'SIN_CONFIRMAR', detalle }
  }
}

function confirmadaHaceMenosDe(config: unknown, ms: number): boolean {
  const confirmedAt = configComoObjeto(configComoObjeto(config).rappiProvisioning).confirmedAt
  if (typeof confirmedAt !== 'string') return false
  const t = Date.parse(confirmedAt)
  return Number.isFinite(t) && Date.now() - t < ms
}

export async function desconectarTiendaRappi(p: {
  venueId: string
  linkId: string
  conexionId: string
  performedBy: string
  origen: 'DASHBOARD' | 'MCP'
  forzar?: boolean
}): Promise<ResultadoDesconectar> {
  // ── 1. Revisar ──────────────────────────────────────────────────────────────────────────
  const link = (await prisma.deliveryChannelLink.findFirst({
    where: { id: p.linkId, venueId: p.venueId },
    select: SAFE_SELECT,
  })) as DeliveryChannelLinkSafe | null
  if (!link) throw new NotFoundError('Canal de delivery no encontrado')
  if (link.provider !== DeliveryProvider.RAPPI) {
    throw new AppError('Sólo las tiendas de Rappi se desconectan desde aquí.', 400, true, 'SOLO_RAPPI')
  }
  if (link.status === DeliveryChannelStatus.DISABLED) return { link, yaEstaba: true, forzada: false }
  if (link.status === DeliveryChannelStatus.PENDING) {
    throw conflicto('RAPPI_CONEXION_EN_CURSO', 'Rappi todavía está confirmando esta tienda; espera a que quede conectada.')
  }
  if (conexionIdDe(link) !== p.conexionId) {
    throw conflicto('RAPPI_CAMBIO_LA_CONEXION', 'La conexión cambió mientras tanto; revisa el estado y vuelve a intentarlo.')
  }
  if (confirmadaHaceMenosDe(link.config, VENTANA_TRAS_CONECTAR_MS)) {
    throw conflicto('RAPPI_OPERACION_EN_CURSO', 'Rappi está terminando de conectar esta tienda; intenta en un minuto.')
  }
  const pedidosEnCurso = (await contarPedidosEnCurso(prisma, [link.id])).get(link.id) ?? 0
  if (pedidosEnCurso > 0) {
    throw conflicto(
      'RAPPI_PEDIDOS_EN_CURSO',
      `Tienes ${pedidosEnCurso} pedido${pedidosEnCurso === 1 ? '' : 's'} de Rappi en curso; termínalo${pedidosEnCurso === 1 ? '' : 's'} antes de desconectar.`,
      { pedidosEnCurso },
    )
  }

  // ── 2. Avisar a Rappi (sin transacción) ─────────────────────────────────────────────────
  const storeId = link.externalLocationId
  let aviso = await avisarNoIntegrada(storeId)
  if (!aviso.ok && p.forzar) aviso = await avisarNoIntegrada(storeId)
  if (!aviso.ok) {
    logger.error('🚨 [Rappi] Rappi no confirmó el «no integrada» al desconectar', {
      linkId: link.id,
      venueId: p.venueId,
      storeId,
      forzar: !!p.forzar,
      ...aviso,
    })
    void logAction({
      staffId: p.performedBy,
      venueId: p.venueId,
      action: 'DELIVERY_INTEGRATION_STATUS_FAILED',
      entity: 'DeliveryChannelLink',
      entityId: link.id,
      data: {
        provider: 'RAPPI',
        externalLocationId: storeId,
        integrada: false,
        tipo: aviso.tipo,
        status: aviso.status ?? null,
        error: aviso.detalle,
        origen: p.origen,
      },
    })
    if (!p.forzar) {
      throw aviso.tipo === 'NO_ACEPTO'
        ? new AppError(
            'Rappi no aceptó la desconexión. Tu tienda sigue conectada; intenta de nuevo en unos minutos.',
            502,
            true,
            'RAPPI_NO_ACEPTO',
          )
        : new AppError(
            'No supimos si Rappi aplicó la desconexión. En Avoqado tu tienda sigue conectada y se aceptan los pedidos que Rappi mande. Intenta de nuevo.',
            502,
            true,
            'RAPPI_SIN_CONFIRMAR',
          )
    }
  }

  // ── 3. Cerrar, sólo si sigue siendo la misma conexión ───────────────────────────────────
  const cierre = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "DeliveryChannelLink" WHERE id = ${link.id} FOR UPDATE`
    const fila = (await tx.deliveryChannelLink.findFirst({
      where: { id: link.id, venueId: p.venueId },
      select: SAFE_SELECT,
    })) as DeliveryChannelLinkSafe | null
    if (!fila) return { tipo: 'NO_ESTA' as const }
    if (fila.status === DeliveryChannelStatus.DISABLED) return { tipo: 'YA_ESTABA' as const, link: fila }
    const vigente = fila.status === DeliveryChannelStatus.ACTIVE || fila.status === DeliveryChannelStatus.PAUSED
    if (!vigente || conexionIdDe(fila) !== p.conexionId) return { tipo: 'CAMBIO' as const, link: fila }
    const hecho = (await tx.deliveryChannelLink.update({
      where: { id: fila.id },
      data: { status: DeliveryChannelStatus.DISABLED, snoozedUntil: null },
      select: SAFE_SELECT,
    })) as DeliveryChannelLinkSafe
    return { tipo: 'DESCONECTADA' as const, link: hecho, statusPrevio: fila.status }
  })

  if (cierre.tipo === 'NO_ESTA') throw new NotFoundError('Canal de delivery no encontrado')
  if (cierre.tipo === 'YA_ESTABA') return { link: cierre.link, yaEstaba: true, forzada: false }
  if (cierre.tipo === 'CAMBIO') {
    // Residuo aceptado (rediseno-r5.md #2): Rappi ya recibió el «no» de esta tienda y aquí sigue conectada con otra conexión.
    logger.warn('🛵 [Rappi] la conexión cambió mientras se avisaba a Rappi: no se desconectó la nueva', {
      linkId: link.id,
      venueId: p.venueId,
      storeIdAvisado: storeId,
      conexionPedida: p.conexionId,
      conexionActual: conexionIdDe(cierre.link),
      statusActual: cierre.link.status,
    })
    throw conflicto('RAPPI_CAMBIO_LA_CONEXION', 'La conexión cambió mientras tanto; revisa el estado y vuelve a intentarlo.')
  }

  const forzada = !aviso.ok
  void logAction({
    staffId: p.performedBy,
    venueId: p.venueId,
    action: 'DELIVERY_CHANNEL_DISCONNECTED',
    entity: 'DeliveryChannelLink',
    entityId: link.id,
    data: {
      provider: 'RAPPI',
      storeId,
      statusPrevio: cierre.statusPrevio,
      origen: p.origen,
      rappiStatus: aviso.status ?? null,
      forzada,
    },
  })
  return { link: cierre.link, yaEstaba: false, forzada }
}
