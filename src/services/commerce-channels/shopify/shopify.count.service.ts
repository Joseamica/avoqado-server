// src/services/commerce-channels/shopify/shopify.count.service.ts
/**
 * Lo apartado para pedidos en línea al confirmar un conteo (12 bis.14, §11.1, §12.1; plan v2 B6). Se cuentan TODAS las
 * piezas del estante y Avoqado guarda `contado − apartadas`, donde las apartadas son las del ESPEJO de la pareja leídas
 * bajo candado en la tx de la línea (`apartadasBajoCandado`). Lo que Shopify cambió y todavía no se jala lo corrige el
 * siguiente jalón: si sube lo apartado, también baja el disponible, así que nada se descuenta dos veces.
 * - Con un envío en camino (`productBlocked ≠ LIBRE`, visto antes del HTTP o bajo candado) la línea NO se aplica (§12.1):
 *   un despacho durante la barrera no se distingue de un pedido, y cualquier número podría estar mal.
 * - Antes de las líneas (`refrescarEspejoParaConteo`), si se puede, se pone el espejo al día con el nivel vigente y
 *   `applyShopifyLevel` (con su cerco). Ese `committed` nunca se usa directo. Lo bloqueado no se pide a Shopify.
 * - Pausa, revocación, sin plan, falta de permiso o Shopify sin contestar: no se habla (o no se espera más) con Shopify
 *   y se usan las apartadas del espejo con su hora. Nunca cero.
 * - Nada de lo que haga Shopify tumba el conteo (K12, B-7): un token ilegible, la red o un error pasajero de la base al
 *   refrescar dejan el espejo como estaba y la línea lo usa (el respaldo de §11.1).
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { SHOPIFY_FEATURE } from './shopify.constants'
import { applyShopifyLevel, fetchLevels, levelKey, productBlocked } from './shopify.mirror.service'
import { atenderFalla, FALTA_PERMISO, pedirCuadre } from './shopify.store.service'

/** El plazo de TODA la lectura de Shopify de un conteo (no uno por tanda): el cajero está esperando. */
const ESPERA_SHOPIFY_MS = 4_000
const IDS_POR_CONSULTA = 200
const SIN_RESPUESTA = 'Shopify no respondió'
/** La línea no se aplicó: había un envío en camino a Shopify (§12.1). */
export const ENVIO_EN_CAMINO = 'ENVIO_EN_CAMINO' as const
export type DepsConteo = { fetchLevels?: typeof fetchLevels; hasAccess?: (venueId: string) => Promise<boolean>; esperaMs?: number }
/**
 * `desde`: una apartada con `committedAt` desde esta hora se leyó en ESTE conteo. `extra`: por qué no, por producto.
 * `bloqueados`: productos con un envío en camino al refrescar (su espejo no se puso al día): su línea se retiene.
 */
export type RefrescoConteo = { desde: Date; extra: Map<string, string>; bloqueados: Set<string> }
export type ApartadasConteo = { apartadas: Prisma.Decimal; nota: string | null }

function hora(d: Date, timeZone: string): string {
  const formato = (tz: string) =>
    new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(d)
  try {
    return formato(timeZone)
  } catch {
    return formato('America/Mexico_City')
  }
}

/** Pone el espejo al día ANTES de las tx de las líneas (nunca HTTP dentro de una tx). Sin red cuando no se puede. */
export async function refrescarEspejoParaConteo(venueId: string, productIds: string[], deps: DepsConteo = {}): Promise<RefrescoConteo> {
  const desde = new Date()
  const extra = new Map<string, string>()
  const bloqueados = new Set<string>()
  // R3: el plan se pregunta UNA vez por conteo; la misma respuesta llega a A, que la vuelve a mirar dentro de su tx.
  let plan: Promise<boolean> | undefined
  const hasAccess = (id: string) => (plan ??= (deps.hasAccess ?? ((v: string) => venueHasFeatureAccess(v, SHOPIFY_FEATURE)))(id))
  const espera = deps.esperaMs ?? ESPERA_SHOPIFY_MS
  let vence: number | undefined // se fija en la primera petición: el presupuesto es de TODA la lectura
  let sinRed = false
  for (let i = 0; i < productIds.length; i += IDS_POR_CONSULTA) {
    const ids = productIds.slice(i, i + IDS_POR_CONSULTA)
    const parejas =
      (await prisma.shopifyVariantLink.findMany({
        where: { venueId, productId: { in: ids }, initializedAt: { not: null }, suspendedReason: null },
        select: {
          id: true,
          productId: true,
          inventoryItemId: true,
          locationLink: {
            select: {
              id: true,
              status: true,
              generation: true,
              storeId: true,
              shopifyLocationId: true,
              importError: true,
              store: { select: { id: true, shopDomain: true, accessTokenCiphertext: true, status: true, tokenVersion: true } },
            },
          },
        },
        take: IDS_POR_CONSULTA,
      })) ?? []
    if (parejas.length === 0) continue
    const link = parejas[0].locationLink // una sola sucursal ligada por negocio (`venueId` único)
    // §12.1: lo que tiene un envío en camino no se pide a Shopify ni se aplica; se revisa ANTES de cualquier HTTP, con
    // UNA consulta agrupada por tanda (Codex A ronda 4). «Bloqueado» es lo mismo que `productBlocked` de A: una fila
    // IN_PROGRESS, o una viva o DEAD_LETTER ambigua, de esta sucursal y esta generación (T3). Bajo candado, cada línea
    // lo vuelve a preguntar con `productBlocked` (`apartadasBajoCandado`).
    const enCamino = await prisma.$queryRaw<Array<{ productId: string }>>`
      SELECT DISTINCT "productId" FROM "ShopifyStockOutbox"
       WHERE "locationLinkId" = ${link.id} AND generation = ${link.generation}
         AND "productId" IN (${Prisma.join(parejas.map(p => p.productId))})
         AND status IN ('PENDING', 'IN_PROGRESS', 'FAILED', 'DEAD_LETTER')
         AND (status = 'IN_PROGRESS' OR ambiguous)`
    for (const b of enCamino) bloqueados.add(b.productId)
    const libres = parejas.filter(p => !bloqueados.has(p.productId))
    if (libres.length === 0) continue
    const marcar = (desdeAqui: number, porque: string) => {
      for (const p of libres.slice(desdeAqui)) extra.set(p.productId, porque)
    }
    let hechos = 0 // los libres de esta tanda que ya se pusieron al día (o se intentó)
    try {
      const motivo =
        link.status === 'PAUSED'
          ? 'Shopify en pausa'
          : link.status !== 'ACTIVE'
            ? null
            : link.store.status !== 'ACTIVE'
              ? 'Shopify desconectado'
              : link.importError === FALTA_PERMISO
                ? 'falta un permiso en Shopify'
                : !(await hasAccess(venueId))
                  ? 'Shopify en pausa por el plan'
                  : null
      if (motivo || link.status !== 'ACTIVE' || sinRed) {
        if (motivo) marcar(0, motivo)
        else if (sinRed) marcar(0, SIN_RESPUESTA)
        continue
      }
      const ahora = Date.now()
      vence ??= ahora + espera
      if (vence <= ahora) {
        marcar(0, SIN_RESPUESTA) // se acabó el presupuesto en otra tanda: ya no se espera más
        sinRed = true
        continue
      }
      const fetchedAt = new Date() // B-1: antes de la petición
      const r = await (deps.fetchLevels ?? fetchLevels)(
        link.store,
        libres.map(p => ({ inventoryItemId: p.inventoryItemId, shopifyLocationId: link.shopifyLocationId })),
        { timeoutMs: vence - ahora },
      )
      if (!r.ok) {
        // §11.3: 401/403/ACCESS_DENIED dejan su marca (con la credencial y la generación con que se leyó) y no se insiste.
        const a = await atenderFalla(link.store, r, [{ id: link.id, generation: link.generation }])
        marcar(0, a === 'SIN_PERMISO' ? 'falta un permiso en Shopify' : a === 'REVOCADA' ? 'Shopify desconectado' : SIN_RESPUESTA)
        sinRed = true // Shopify no contestó bien: el resto del conteo usa el espejo, sin otra espera
        continue
      }
      const cerco = {
        generation: link.generation,
        storeId: link.storeId,
        shopifyLocationId: link.shopifyLocationId,
        tokenVersion: link.store.tokenVersion,
      }
      let cuadrePedido = false
      for (; hechos < libres.length; hechos++) {
        const p = libres[hechos]
        const nivel = r.data.get(levelKey(link.shopifyLocationId, p.inventoryItemId))
        if (!nivel) continue
        const o = await applyShopifyLevel(
          { variantLinkId: p.id, nivel, fetchedAt, cause: 'nivel vigente al confirmar un conteo' },
          { hasAccess, cerco },
        )
        if (o === 'CONTEXTO_CAMBIO') {
          // §12.2: la tienda se revocó, se marcó un error terminal o se reconectó mientras se leía. A no tocó nada: el resto
          // de la tanda usa el espejo con su hora, como cuando Shopify no contesta.
          marcar(hechos, 'la conexión con Shopify cambió')
          sinRed = true
          break
        }
        if (o === 'REINTENTAR' || o === 'INCIERTO') {
          // Apareció un envío en camino entre la revisión y la lectura: el espejo no se puso al día ⇒ la línea se retiene.
          bloqueados.add(p.productId)
          if (!cuadrePedido) await pedirCuadre(link.id)
          cuadrePedido = true
        }
      }
    } catch (err) {
      // K12 / B-7: un token ilegible (`fetchLevels` lanza al descifrar), la red o la base (P2028, P2024…) no tumban el
      // conteo. Lo que no alcanzó a ponerse al día usa el espejo, que es coherente con Inventory (§11.1).
      logger.warn(`[SHOPIFY] conteo del negocio ${venueId}: no se pudo refrescar el espejo (${(err as Error)?.message ?? err})`)
      marcar(hechos, SIN_RESPUESTA)
      sinRed = true
    }
  }
  return { desde, extra, bloqueados }
}

/**
 * Dentro de la tx de UNA línea (§11.1): sucursal → tienda `FOR SHARE` → pareja `FOR UPDATE` (quien llama bloquea
 * `Inventory` después). Con un envío en camino —visto en el refresco o ahora, bajo candado— devuelve `ENVIO_EN_CAMINO`
 * y la línea no se aplica (§12.1). Si no, las apartadas VIGENTES del espejo, con su nota. Sin pareja viva, o
 * desconectada: null (el objetivo es el contado). La primera lectura no bloquea: en los tests unitarios el delegado
 * devuelve null y no se consume ningún `$queryRaw` del flujo de siempre.
 */
export async function apartadasBajoCandado(
  tx: Prisma.TransactionClient,
  productId: string,
  refresco: RefrescoConteo,
): Promise<ApartadasConteo | typeof ENVIO_EN_CAMINO | null> {
  const ref = await tx.shopifyVariantLink.findUnique({ where: { productId }, select: { id: true, locationLinkId: true } })
  if (!ref) return null
  const [l] = await tx.$queryRaw<Array<{ status: string; storeId: string; generation: number; timezone: string }>>`
    SELECT l.status::text AS status, l."storeId", l.generation, v.timezone
      FROM "ShopifyLocationLink" l JOIN "Venue" v ON v.id = l."venueId"
     WHERE l.id = ${ref.locationLinkId}
     FOR SHARE OF l`
  if (!l || l.status === 'DISCONNECTED') return null
  await tx.$queryRaw`SELECT id FROM "ShopifyStore" WHERE id = ${l.storeId} FOR SHARE`
  const [p] = await tx.$queryRaw<
    Array<{ mirrorCommitted: number; committedAt: Date | null; mirrorAt: Date; initializedAt: Date | null; suspendedReason: string | null }>
  >`
    SELECT "mirrorCommitted", "committedAt", "mirrorAt", "initializedAt", "suspendedReason"::text AS "suspendedReason"
      FROM "ShopifyVariantLink" WHERE id = ${ref.id} FOR UPDATE`
  if (!p || !p.initializedAt || p.suspendedReason) return null
  if (refresco.bloqueados.has(productId) || (await productBlocked(tx, productId, ref.locationLinkId, l.generation)) !== 'LIBRE')
    return ENVIO_EN_CAMINO
  if (p.mirrorCommitted <= 0) return null
  const extra = refresco.extra.get(productId)
  const cuando = p.committedAt ?? p.mirrorAt
  const base =
    cuando >= refresco.desde && !extra
      ? `menos ${p.mirrorCommitted} apartadas en línea`
      : `menos ${p.mirrorCommitted} apartadas según Shopify a las ${hora(cuando, l.timezone)}`
  return { apartadas: new Prisma.Decimal(p.mirrorCommitted), nota: extra ? `${base}; ${extra}` : base }
}
