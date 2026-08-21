/**
 * Mantener el menú del proveedor igual al de Avoqado, sin que nadie se acuerde de publicarlo.
 *
 * 🔴 POR QUÉ IMPORTA (founder, 2026-08-20): un menú desactualizado en Uber cuesta dinero de
 * dos formas, y ninguna falla visiblemente:
 *   · El cliente paga el precio VIEJO. Uber cobra lo que su menú dice; nosotros recibimos
 *     eso. Si subiste el precio y Uber no se enteró, la diferencia la come el negocio.
 *   · El cliente pide algo que ya no existe y hay que rechazar el pedido. Uber exige
 *     **99.9% de tasa de inyección** y por debajo del 99% REVOCA el acceso. Los rechazos
 *     por menú viejo se pagan con la integración entera.
 *
 * 🔴 POR HUELLA, NO POR EVENTOS. Se compara una huella del menú publicado contra la del
 * menú actual, en vez de engancharse a cada edición de producto. La diferencia es lo que
 * hace que esto SIRVA:
 *   · Un enganche por evento sólo ve los caminos que alguien se acordó de instrumentar. En
 *     este repo el menú se toca desde el dashboard, el MCP, scripts de migración y a veces
 *     SQL directo — el primero que no dispare el evento deja el menú viejo para siempre,
 *     en silencio.
 *   · La huella se AUTO-CORRIGE: si una publicación falló, o el proceso murió a media
 *     publicación, o alguien cambió algo por fuera, la siguiente pasada lo detecta sola.
 *   · Es idempotente por construcción: sin cambios, no publica nada.
 */
import { createHash } from 'node:crypto'

import { DeliveryChannelStatus, type DeliveryChannelLink } from '@prisma/client'

import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

import { adapterFor, hasAdapter } from './adapterRegistry'
import { buildMenuSnapshot } from './menuSnapshot.service'

export type MenuSyncOutcome = 'PUBLISHED' | 'UNCHANGED' | 'NO_PUBLISHER' | 'FAILED'

export interface MenuSyncResult {
  outcome: MenuSyncOutcome
  linkId: string
  items?: number
  error?: string
}

/** Huella estable del menú TAL COMO SE VA A PUBLICAR. */
function huella(payload: unknown): string {
  // Se hashea el payload YA TRADUCIDO, no el snapshot interno, y es deliberado: si mañana
  // arreglamos un bug del traductor, la huella cambia y el menú se republica solo. Hashear
  // el snapshot dejaría a Uber con el menú mal traducido hasta que alguien editara un
  // producto por casualidad.
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/**
 * Publica el menú de un canal SÓLO si cambió.
 *
 * @param force Publica aunque la huella coincida. Es para `store.menu_refresh_request`:
 *   cuando Uber PIDE el menú, se lo damos aunque creamos que ya lo tiene — si lo pide es
 *   porque algo se le perdió, y discutirle sería confiar en nuestro registro por encima del
 *   suyo justo en el caso donde el nuestro está mal.
 */
export async function syncChannelMenu(link: DeliveryChannelLink, opts: { force?: boolean } = {}): Promise<MenuSyncResult> {
  if (!hasAdapter(link.provider)) return { outcome: 'NO_PUBLISHER', linkId: link.id }

  const adapter = adapterFor(link.provider)
  if (typeof adapter.publishMenu !== 'function') return { outcome: 'NO_PUBLISHER', linkId: link.id }

  try {
    const snapshot = await buildMenuSnapshot(link.venueId)
    // Se traduce ANTES de decidir: es lo que de verdad va a viajar, y es lo que hay que
    // comparar. Cuesta CPU y nada de red.
    const payload = adapter.buildMenuPayload ? adapter.buildMenuPayload(snapshot) : snapshot
    const actual = huella(payload)

    if (!opts.force && actual === link.lastMenuHash) return { outcome: 'UNCHANGED', linkId: link.id }

    const r = await adapter.publishMenu(snapshot, link.externalLocationId)
    if (!r.ok) {
      // 🔴 NO se guarda la huella si falló: guardarla haría que la siguiente pasada creyera
      // que Uber ya lo tiene, y el menú se quedaría viejo PARA SIEMPRE sin volver a intentar.
      logger.error('🚨 [MenuSync] el proveedor rechazó el menú — queda desactualizado', {
        linkId: link.id,
        venueId: link.venueId,
        provider: link.provider,
        status: r.status,
        cuerpo: r.raw.slice(0, 300),
      })
      return { outcome: 'FAILED', linkId: link.id, error: `HTTP ${r.status}` }
    }

    await prisma.deliveryChannelLink.update({
      where: { id: link.id },
      data: { lastMenuHash: actual, lastMenuSyncAt: new Date() },
    })

    const items = (payload as { items?: unknown[] })?.items?.length
    logger.info('📋 [MenuSync] menú actualizado en el proveedor', {
      linkId: link.id,
      venueId: link.venueId,
      provider: link.provider,
      items,
    })
    return { outcome: 'PUBLISHED', linkId: link.id, items }
  } catch (error) {
    logger.error('🚨 [MenuSync] falló la sincronización del menú', {
      linkId: link.id,
      venueId: link.venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { outcome: 'FAILED', linkId: link.id, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Los canales que deben mantenerse sincronizados: activos y con el auto-sync prendido. */
export function syncableLinksWhere() {
  return {
    status: DeliveryChannelStatus.ACTIVE,
    // El dueño puede apagarlo si maneja su menú de Uber a mano — pero es opt-OUT: el default
    // del schema es `true`, porque el peligro es el menú viejo, no el sincronizado.
    autoSyncMenu: true,
  }
}
