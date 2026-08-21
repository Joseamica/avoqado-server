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
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'

import { resolveDeliveryHours } from './deliveryHours.service'
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

    // 🔴 El horario va SIEMPRE, y entra en la huella: si el dueño cambia sus horas, el menú
    // se republica solo. Antes se publicaba 24/7 en silencio y nadie se enteraba de que su
    // negocio aparecía abierto de madrugada.
    const { horario, fuente } = await resolveDeliveryHours(link)
    const availability = typeof adapter.mapHours === 'function' ? adapter.mapHours(horario) : undefined

    // 🔴 Precios propios del canal. Uber cobra ~30% de comisión, así que casi todo comercio
    // publica más caro allá. Sin esto, este sincronizador le borraría su markup CADA 5
    // MINUTOS y perdería dinero en cada pedido sin entender por qué — es la falla que los
    // agregadores (Otter, Chowly) documentan como la más común al conectar un POS.
    const precios = (link.config as { precios?: unknown } | null)?.precios
    // Se traduce ANTES de decidir: es lo que de verdad va a viajar, y es lo que hay que
    // comparar. Cuesta CPU y nada de red.
    const payload = adapter.buildMenuPayload ? adapter.buildMenuPayload(snapshot, { availability, precios }) : snapshot
    const actual = huella(payload)

    if (!opts.force && actual === link.lastMenuHash) return { outcome: 'UNCHANGED', linkId: link.id }

    const r = await adapter.publishMenu(snapshot, link.externalLocationId, { availability, precios })
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

// ─────────────────────────────────────────────────────────────────────────────────────────
// DISPONIBILIDAD (agotar / revivir un producto)
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Marca en el proveedor los productos que se acabaron, y revive los que volvieron.
 *
 * 🔴 Es la operación que más veces al día importa, y es lo CONTRARIO de republicar el menú:
 * toca un item, es barata, y no puede romper nada. Sin ella el proveedor sigue vendiendo lo
 * que ya no hay — o entregas de menos, o rechazas el pedido, y cada rechazo cuenta contra la
 * tasa de inyección que Uber exige para no revocar el acceso.
 *
 * 🔴 SÓLO productos que de verdad llevan inventario, y sólo si el venue tiene la función
 * activa. Sin `INVENTORY_TRACKING` los números de stock no se mantienen y son basura:
 * agotar productos con base en basura los ESCONDE de la app sin motivo, que es peor que
 * venderlos de más.
 *
 * [mercado] Es exactamente lo que hace Square: marca agotado al llegar a cero **sólo si ese
 * producto tiene el seguimiento de inventario prendido**; si no, lo sigue vendiendo.
 *
 * ⚠️ Y NO contradice nuestra paridad de stock negativo (Square-parity, 2026-08-12): dejar
 * vender por debajo de cero es para el MOSTRADOR, donde hay una persona que ve la bodega y
 * decide. En un marketplace nadie está ahí: el cliente pide a ciegas y el rechazo lo paga el
 * negocio. Contextos distintos, decisiones distintas, a propósito.
 *
 * ⚠️ LÍMITE CONOCIDO: sólo cubre productos con inventario PROPIO. Un platillo cuya
 * disponibilidad depende de su receta (se acabó la carne ⇒ no hay hamburguesas) NO se detecta
 * todavía — hace falta explotar recetas, que es su propia rebanada.
 */
export async function syncChannelAvailability(link: DeliveryChannelLink): Promise<{ agotados: number; revividos: number }> {
  if (!hasAdapter(link.provider)) return { agotados: 0, revividos: 0 }
  const adapter = adapterFor(link.provider)
  if (typeof adapter.setItemSoldOut !== 'function') return { agotados: 0, revividos: 0 }

  if (!(await venueHasFeatureAccess(link.venueId, 'INVENTORY_TRACKING'))) return { agotados: 0, revividos: 0 }

  // (a) Productos con inventario PROPIO que se acabaron.
  const sinStock = await prisma.product.findMany({
    where: { venueId: link.venueId, active: true, inventory: { currentStock: { lte: 0 } } },
    select: { sku: true },
  })
  const deben = new Set(sinStock.map(p => p.sku).filter(Boolean) as string[])

  // (b) 🔴 Platillos que NO SE PUEDEN HACER porque falta un ingrediente. Es el caso que de
  // verdad pasa en una cocina: no se acaba "la hamburguesa", se acaba la carne — y entonces
  // TODOS los platillos que la llevan dejan de existir. Sin esto, Uber los sigue vendiendo y
  // cada uno termina en un rechazo, que es lo que cuenta contra la tasa de inyección.
  const conReceta = await prisma.product.findMany({
    where: { venueId: link.venueId, active: true, recipe: { isNot: null } },
    select: {
      sku: true,
      recipe: {
        select: {
          portionYield: true,
          lines: {
            // Un ingrediente OPCIONAL que falte no impide hacer el platillo — sólo sale sin
            // él. Contarlo agotaría platillos que sí se pueden preparar.
            where: { isOptional: false },
            select: { quantity: true, rawMaterial: { select: { currentStock: true, name: true } } },
          },
        },
      },
    },
  })

  for (const p of conReceta) {
    if (!p.sku || !p.recipe) continue
    const porciones = p.recipe.portionYield > 0 ? p.recipe.portionYield : 1
    const faltaAlgo = p.recipe.lines.some(l => {
      // Lo que se necesita para UNA porción: la receta rinde `portionYield`.
      const necesario = l.quantity.div(porciones)
      return l.rawMaterial.currentStock.lessThan(necesario)
    })
    if (faltaAlgo) deben.add(p.sku)
  }

  // Lo que ya le dijimos al proveedor. Se guarda la LISTA y no una huella: hace falta el
  // contenido para mandar sólo la diferencia — repetir el estado de 96 productos cada 5
  // minutos serían 96 llamadas por nada.
  const previo = new Set(((link.config as { soldOutSkus?: string[] } | null)?.soldOutSkus ?? []) as string[])

  const agotar = [...deben].filter(sku => !previo.has(sku))
  const revivir = [...previo].filter(sku => !deben.has(sku))
  if (agotar.length === 0 && revivir.length === 0) return { agotados: 0, revividos: 0 }

  const logrados = new Set(previo)
  for (const sku of agotar) {
    const r = await adapter.setItemSoldOut(sku, link.externalLocationId, true)
    // Sólo se registra lo que el proveedor ACEPTÓ. Guardar un fallo como hecho haría que la
    // siguiente pasada creyera que ya está agotado y nunca lo reintentara.
    if (r.ok) logrados.add(sku)
  }
  for (const sku of revivir) {
    const r = await adapter.setItemSoldOut(sku, link.externalLocationId, false)
    if (r.ok) logrados.delete(sku)
  }

  await prisma.deliveryChannelLink.update({
    where: { id: link.id },
    data: { config: { ...((link.config as object) ?? {}), soldOutSkus: [...logrados] } },
  })

  logger.info('🥡 [MenuSync] disponibilidad actualizada en el proveedor', {
    linkId: link.id,
    venueId: link.venueId,
    agotados: agotar.length,
    revividos: revivir.length,
  })
  return { agotados: agotar.length, revividos: revivir.length }
}
