// src/services/commerce-channels/shopify/shopify.mirror.service.ts
/**
 * El espejo: lo que Avoqado cree que Shopify tiene disponible en la ubicación de cada sucursal.
 *
 * Invariante operativo (§9.3; pareja iniciada y no suspendida):
 *   Inventory.currentStock = mirrorAvailable + Σ vivas (PENDING, IN_PROGRESS, FAILED) + Σ DEAD_LETTER sin resolver
 *                            + offset de la revisión OPEN, del producto en la generación vigente.
 *
 * 🔴 La barrera de un envío que pudo llegar a Shopify (IN_PROGRESS, o cualquier fila `ambiguous`) nunca se borra aquí:
 * mientras exista, nada aplica, suspende-descartándola, reinicia ni reactiva ese producto (§9.1, N1 de Codex).
 *
 * 🔴 Cerco (§11.2): quien leyó Shopify con un contexto (generación, tienda, ubicación, credencial, lease del worker,
 * reclamo del evento) lo manda en `deps.cerco`, y se compara DENTRO de la transacción, bajo los candados. Si cambió, el
 * resultado es CONTEXTO_CAMBIO y no se toca nada: una lectura vieja nunca escribe en una conexión nueva.
 *
 * Escriben el espejo SÓLO: applyShopifyLevel, initializePair, el mensajero al confirmar un envío y (plan B) la
 * resolución de «Por revisar». Todos con la marca anti-eco y bajo candado de la pareja.
 * Orden de candados (§10.3): Product (sólo si se toca; aquí nunca) → sucursal (FOR SHARE) → tienda (FOR SHARE) →
 * pareja (FOR UPDATE) → Inventory → buzón/revisión → evento (FOR SHARE, al final).
 */
import { Prisma, ShopifyIssueReason, ShopifySuspendReason } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { isNonInventoriable } from '@/services/dashboard/quantityInventoryRow'
import { decryptShopifyToken } from './shopify.crypto'
import { shopifyGraphql, ShopifyResult } from './shopify.graphql'
import { LEVELS_PAGE_SIZE, LIVE_OUTBOX_STATUSES, SHOPIFY_FEATURE, SHOPIFY_SERVICE_ACTOR } from './shopify.constants'
import { notifyShopify } from './shopify.notify.service'

export type NivelLeido = { kind: 'OK'; available: number; committed: number } | { kind: 'SIN_NIVEL' } | { kind: 'NO_RASTREADO' }
export type ApplyOutcome =
  | 'APLICADO'
  | 'SIN_CAMBIO'
  | 'REINTENTAR'
  | 'INCIERTO'
  | 'PAUSADO'
  | 'SUSPENDIDO'
  | 'NO_INICIADA'
  | 'CONTEXTO_CAMBIO'
export type InitOutcome = 'INICIADA' | 'EN_REVISION' | 'SUSPENDIDA' | 'REINTENTAR' | 'NO_APLICA' | 'CONTEXTO_CAMBIO'
/** El contexto con el que el llamador leyó (§11.2). `workToken` y `evento` sólo si el llamador los tiene. */
export type CercoShopify = {
  generation: number
  storeId: string
  shopifyLocationId: string
  tokenVersion: number
  workToken?: string
  evento?: { id: string; claimToken: string }
}
type Deps = { hasAccess?: (venueId: string) => Promise<boolean>; cerco?: CercoShopify }

/** Errores de la sucursal que detienen todo hasta que alguien actúe (§12.2); sólo los limpia renovar la credencial. */
export const SHOPIFY_IMPORT_ERRORES_TERMINALES: string[] = ['FALTA_PERMISO', 'CATALOGO_MUY_GRANDE', 'CATALOGO_MAESTRO']

const accesoReal = (venueId: string) => venueHasFeatureAccess(venueId, SHOPIFY_FEATURE)

export function levelKey(shopifyLocationId: string, inventoryItemId: string): string {
  return `${shopifyLocationId}|${inventoryItemId}`
}

/** La marca anti-eco: el guardia no encola lo que esta transacción escriba en Inventory. Muere con la transacción. */
export async function marcarOrigenShopify(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$queryRaw`SELECT set_config('avoqado.stock_origen', 'shopify', true)`
}

// ─── Lectura de niveles ─────────────────────────────────────────────────────────────────────────────────────

const QUERY_NIVELES = `query Niveles($ids: [ID!]!, $loc: ID!) {
  nodes(ids: $ids) {
    ... on InventoryItem {
      id
      tracked
      inventoryLevel(locationId: $loc) { isActive quantities(names: ["available", "committed"]) { name quantity } }
    }
  }
}`

type Cantidad = { name: string; quantity: number }
type NodoNivel = { id: string; tracked: boolean; inventoryLevel: { isActive: boolean; quantities: Cantidad[] } | null } | null

/** Shopify rechaza cantidades fuera de ±2,000,000,000 (INVALID_QUANTITY_TOO_HIGH/LOW): fuera de eso no es un dato real. */
const MAX_CANTIDAD = 2_000_000_000
const cantidad = (q: Cantidad[], name: string): number => q.find(x => x?.name === name)?.quantity as number
function cantidadValida(q: Cantidad[], name: string): boolean {
  const del = q.filter(x => x?.name === name)
  return del.length === 1 && Number.isSafeInteger(del[0].quantity) && Math.abs(del[0].quantity) <= MAX_CANTIDAD
}

/** Un nodo es `null` (ausencia explícita) o el InventoryItem PEDIDO en esa posición con su forma completa (N4). */
function nodoValido(n: unknown, pedido: string): boolean {
  if (n === null) return true
  if (typeof n !== 'object') return false
  const x = n as { id?: unknown; tracked?: unknown; inventoryLevel?: { isActive?: unknown; quantities?: unknown } | null }
  if (x.id !== pedido || typeof x.tracked !== 'boolean') return false
  if (x.inventoryLevel === null) return true
  const lvl = x.inventoryLevel
  if (typeof lvl?.isActive !== 'boolean' || !Array.isArray(lvl.quantities)) return false
  if (!lvl.isActive) return true
  const q = lvl.quantities as Cantidad[]
  return cantidadValida(q, 'available') && cantidadValida(q, 'committed')
}
/** `nodes(ids)` contesta en el orden pedido: misma cantidad y, posición por posición, el mismo id o `null`. */
const respuestaNivelesDe =
  (pedidos: string[]) =>
  (d: unknown): d is { nodes: NodoNivel[] } => {
    const nodes = (d as { nodes?: unknown } | null)?.nodes
    return Array.isArray(nodes) && nodes.length === pedidos.length && nodes.every((n, i) => nodoValido(n, pedidos[i]))
  }

function leerNivel(n: NodoNivel): NivelLeido {
  if (!n) return { kind: 'SIN_NIVEL' }
  if (!n.tracked) return { kind: 'NO_RASTREADO' }
  const lvl = n.inventoryLevel
  if (!lvl || !lvl.isActive) return { kind: 'SIN_NIVEL' }
  return { kind: 'OK', available: cantidad(lvl.quantities, 'available'), committed: cantidad(lvl.quantities, 'committed') }
}

/**
 * Lee available y committed de cada (ubicación, artículo). TODA llave pedida sale en el mapa (#3, #4). `timeoutMs`
 * (§11.6) es el plazo de TODA la lectura: cada página recibe lo que queda, y sin tiempo la siguiente no empieza
 * (TIMEOUT, reintentable).
 */
export async function fetchLevels(
  store: { shopDomain: string; accessTokenCiphertext: Uint8Array | Buffer },
  items: Array<{ inventoryItemId: string; shopifyLocationId: string }>,
  deps: { graphql?: typeof shopifyGraphql; timeoutMs?: number } = {},
): Promise<ShopifyResult<Map<string, NivelLeido>>> {
  const graphql = deps.graphql ?? shopifyGraphql
  const vence = deps.timeoutMs === undefined ? undefined : Date.now() + deps.timeoutMs
  const token = decryptShopifyToken(store.accessTokenCiphertext)
  const porUbicacion = new Map<string, Set<string>>()
  for (const it of items) {
    const ids = porUbicacion.get(it.shopifyLocationId) ?? new Set<string>()
    ids.add(it.inventoryItemId)
    porUbicacion.set(it.shopifyLocationId, ids)
  }
  const out = new Map<string, NivelLeido>()
  for (const [loc, conjunto] of porUbicacion) {
    const ids = [...conjunto]
    for (let i = 0; i < ids.length; i += LEVELS_PAGE_SIZE) {
      const tanda = ids.slice(i, i + LEVELS_PAGE_SIZE)
      const restante = vence === undefined ? undefined : vence - Date.now()
      if (restante !== undefined && restante <= 0) {
        return {
          ok: false,
          code: 'TIMEOUT',
          retryable: true,
          ambiguous: true,
          message: 'se acabó el plazo antes de la siguiente página de niveles',
        }
      }
      const r = await graphql<{ nodes: NodoNivel[] }>(
        store.shopDomain,
        token,
        QUERY_NIVELES,
        { ids: tanda, loc },
        { validate: respuestaNivelesDe(tanda), timeoutMs: restante },
      )
      if (!r.ok) return r
      tanda.forEach((id, j) => out.set(levelKey(loc, id), leerNivel(r.data.nodes[j])))
    }
  }
  return { ok: true, data: out }
}

// ─── Candados, cerco y consultas compartidas ────────────────────────────────────────────────────────────────

type ParejaBloqueada = {
  id: string
  venueId: string
  productId: string
  locationLinkId: string
  shopifyVariantId: string
  initializedAt: Date | null
  createdProduct: boolean
  suspendedReason: ShopifySuspendReason | null
  mirrorAvailable: number
  mirrorAt: Date
  linkStatus: string
  generation: number
  applyRequestedAt: Date | null
  storeId: string
  shopifyLocationId: string
  workToken: string | null
  importError: string | null
  storeStatus: string
  tokenVersion: number
}
type ContextoLeido = Pick<
  ParejaBloqueada,
  'generation' | 'storeId' | 'shopifyLocationId' | 'workToken' | 'importError' | 'storeStatus' | 'tokenVersion'
>

/**
 * ¿El contexto leído bajo candado es el del cerco? Sin cerco, siempre sí. Con cerco exige además tienda ACTIVE y ningún
 * error terminal en la sucursal (§12.2): una tienda revocada o una sucursal detenida no aceptan efectos de nadie.
 */
function coincide(x: ContextoLeido, cerco?: CercoShopify): boolean {
  if (!cerco) return true
  return (
    x.storeStatus === 'ACTIVE' &&
    !(x.importError !== null && SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(x.importError)) &&
    x.generation === cerco.generation &&
    x.storeId === cerco.storeId &&
    x.shopifyLocationId === cerco.shopifyLocationId &&
    x.tokenVersion === cerco.tokenVersion &&
    (cerco.workToken === undefined || x.workToken === cerco.workToken)
  )
}

/**
 * El cerco de una sucursal, tomando sucursal y tienda FOR SHARE (§10.3). `false` también con la tienda no ACTIVE o un
 * error terminal en la sucursal (§12.2). Lo usan el mensajero y B.
 */
export async function cercoVigente(tx: Prisma.TransactionClient, locationLinkId: string, cerco: CercoShopify): Promise<boolean> {
  const [l] = await tx.$queryRaw<
    Array<{ storeId: string; shopifyLocationId: string; generation: number; workToken: string | null; importError: string | null }>
  >`
    SELECT "storeId", "shopifyLocationId", generation, "workToken", "importError"
      FROM "ShopifyLocationLink" WHERE id = ${locationLinkId} FOR SHARE`
  if (!l) return false
  const [s] = await tx.$queryRaw<Array<{ storeStatus: string; tokenVersion: number }>>`
    SELECT status::text AS "storeStatus", "tokenVersion" FROM "ShopifyStore" WHERE id = ${l.storeId} FOR SHARE`
  return !!s && coincide({ ...l, ...s }, cerco)
}

/** El reclamo del evento sigue siendo de quien llama. Se toma AL FINAL de la transacción, FOR SHARE (§11.2). */
export async function eventoVigente(tx: Prisma.TransactionClient, evento?: { id: string; claimToken: string }): Promise<boolean> {
  if (!evento) return true
  const [ev] = await tx.$queryRaw<Array<{ claimToken: string | null }>>`
    SELECT "claimToken" FROM "ShopifyInboundEvent" WHERE id = ${evento.id} FOR SHARE`
  return !!ev && ev.claimToken === evento.claimToken
}

/**
 * Sucursal (FOR SHARE) → tienda (FOR SHARE) → pareja (FOR UPDATE), en ese orden y en sentencias separadas (§10.3). Quien
 * además toque `Product` (catálogo, archivo, `switchInventoryMethod` en B) lo bloquea ANTES de llamar aquí. Exportada
 * para B (K14, BR-6): toda mutación de pareja de B pasa antes por aquí.
 */
export async function bloquearPareja(tx: Prisma.TransactionClient, variantLinkId: string): Promise<ParejaBloqueada | null> {
  const [link] = await tx.$queryRaw<
    Array<{
      id: string
      storeId: string
      shopifyLocationId: string
      workToken: string | null
      importError: string | null
      linkStatus: string
      generation: number
      applyRequestedAt: Date | null
    }>
  >`
    SELECT l.id, l."storeId", l."shopifyLocationId", l."workToken", l."importError", l.status::text AS "linkStatus",
           l.generation, l."applyRequestedAt"
      FROM "ShopifyLocationLink" l
     WHERE l.id = (SELECT v."locationLinkId" FROM "ShopifyVariantLink" v WHERE v.id = ${variantLinkId})
     FOR SHARE`
  if (!link) return null
  const [store] = await tx.$queryRaw<Array<{ storeStatus: string; tokenVersion: number }>>`
    SELECT status::text AS "storeStatus", "tokenVersion" FROM "ShopifyStore" WHERE id = ${link.storeId} FOR SHARE`
  const [v] = await tx.$queryRaw<
    Array<{
      id: string
      venueId: string
      productId: string
      locationLinkId: string
      shopifyVariantId: string
      initializedAt: Date | null
      createdProduct: boolean
      suspendedReason: ShopifySuspendReason | null
      mirrorAvailable: number
      mirrorAt: Date
    }>
  >`
    SELECT id, "venueId", "productId", "locationLinkId", "shopifyVariantId", "initializedAt", "createdProduct",
           "suspendedReason"::text AS "suspendedReason", "mirrorAvailable", "mirrorAt"
      FROM "ShopifyVariantLink"
     WHERE id = ${variantLinkId} AND "locationLinkId" = ${link.id}
     FOR UPDATE`
  if (!store || !v) return null
  return {
    ...v,
    linkStatus: link.linkStatus,
    generation: link.generation,
    applyRequestedAt: link.applyRequestedAt,
    storeId: link.storeId,
    shopifyLocationId: link.shopifyLocationId,
    workToken: link.workToken,
    importError: link.importError,
    storeStatus: store.storeStatus,
    tokenVersion: store.tokenVersion,
  }
}

async function bloquearInventario(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<{ id: string; currentStock: Prisma.Decimal } | null> {
  const [inv] = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal }>>`
    SELECT id, "currentStock" FROM "Inventory" WHERE "productId" = ${productId} FOR UPDATE`
  return inv ? { id: inv.id, currentStock: new Prisma.Decimal(inv.currentStock) } : null
}

/**
 * §12.5: bloquea, por id, las filas que la tx puede modificar —las del buzón del producto que no están en camino
 * (PENDING, FAILED, DEAD_LETTER) y, con `revision`, sus revisiones OPEN— DESPUÉS de `Inventory` y ANTES de mirar el
 * evento. Con `Inventory` bloqueado nadie encola filas nuevas de este producto mientras tanto. Las IN_PROGRESS no se
 * tocan: nada aquí las modifica.
 */
async function bloquearFilasDelProducto(
  tx: Prisma.TransactionClient,
  p: { productId: string; locationLinkId: string; generation: number },
  revision: boolean,
): Promise<void> {
  // ponytail: sin tope; las filas vivas de UN producto son las ventas entre dos envíos. Por tandas si un paro largo junta miles.
  await tx.$queryRaw`
    SELECT id FROM "ShopifyStockOutbox"
     WHERE "productId" = ${p.productId} AND "locationLinkId" = ${p.locationLinkId} AND generation = ${p.generation}
       AND status IN ('PENDING', 'FAILED', 'DEAD_LETTER')
     ORDER BY id
     FOR UPDATE`
  if (revision) {
    await tx.$queryRaw`SELECT id FROM "ShopifyReviewItem" WHERE "productId" = ${p.productId} AND status = 'OPEN' ORDER BY id FOR UPDATE`
  }
}

export async function liveOutboxSum(
  tx: Prisma.TransactionClient,
  productId: string,
  locationLinkId: string,
  generation: number,
): Promise<Prisma.Decimal> {
  const r = await tx.shopifyStockOutbox.aggregate({
    where: { productId, locationLinkId, generation, status: { in: [...LIVE_OUTBOX_STATUSES] } },
    _sum: { delta: true },
  })
  return r._sum.delta ?? new Prisma.Decimal(0)
}

/** EN_VUELO = una fila IN_PROGRESS; INCIERTO = una fila viva o DEAD_LETTER con `ambiguous` (12 bis.1). */
export async function productBlocked(
  tx: Prisma.TransactionClient,
  productId: string,
  locationLinkId: string,
  generation: number,
): Promise<'LIBRE' | 'EN_VUELO' | 'INCIERTO'> {
  const [b] = await tx.$queryRaw<Array<{ enVuelo: boolean | null; incierto: boolean | null }>>`
    SELECT bool_or(status = 'IN_PROGRESS') AS "enVuelo", bool_or(ambiguous) AS incierto
      FROM "ShopifyStockOutbox"
     WHERE "productId" = ${productId} AND "locationLinkId" = ${locationLinkId} AND generation = ${generation}
       AND status IN ('PENDING', 'IN_PROGRESS', 'FAILED', 'DEAD_LETTER')`
  if (b?.enVuelo) return 'EN_VUELO'
  if (b?.incierto) return 'INCIERTO'
  return 'LIBRE'
}

// ─── Falta un permiso (§11.3) ───────────────────────────────────────────────────────────────────────────────

/**
 * Marca «falta permiso» sólo si la falla viene de la credencial VIGENTE (y, con `locationLinkId`, de la generación
 * vigente de esa sucursal). Pone `importError = 'FALTA_PERMISO'` en los enlaces afectados —el reclamo del buzón y el
 * worker de B dejan de trabajarlos hasta reautorizar— y avisa una sola vez (sólo a los que no estaban marcados).
 * Devuelve `false` si la falla es de una credencial o generación vieja: el llamador la trata como reintentable.
 * Candados: con `locationLinkId`, SÓLO ese enlace; sin él, los de la tienda por id. FOR NO KEY UPDATE (no toca llaves):
 * no frena el FOR KEY SHARE de quien inserte con una llave foránea al enlace; después, la tienda FOR SHARE (§10.3).
 * Quien la llame lo hace antes de cualquier candado de pareja, fila o cerco en esa tx, o en una tx propia (A7-6).
 * El aviso sale dentro de la tx del llamador por la firma del contrato: si esa tx se deshace, el aviso pudo salir de más
 * (repetición, nunca pérdida).
 */
export async function marcarFaltaPermiso(
  tx: Prisma.TransactionClient,
  o: { storeId: string; tokenVersion: number; locationLinkId?: string; generation?: number },
): Promise<boolean> {
  type Enlace = { id: string; venueId: string; generation: number; importError: string | null }
  const enlaces =
    o.locationLinkId !== undefined
      ? await tx.$queryRaw<Enlace[]>`
          SELECT id, "venueId", generation, "importError" FROM "ShopifyLocationLink"
           WHERE id = ${o.locationLinkId} AND "storeId" = ${o.storeId} AND status <> 'DISCONNECTED'
           FOR NO KEY UPDATE`
      : // ponytail: las sucursales de UNA tienda son un puñado; el tope es defensa. Por tandas si alguna organización pasa de 1000.
        await tx.$queryRaw<Enlace[]>`
          SELECT id, "venueId", generation, "importError" FROM "ShopifyLocationLink"
           WHERE "storeId" = ${o.storeId} AND status <> 'DISCONNECTED'
           ORDER BY id
           LIMIT 1000
           FOR NO KEY UPDATE`
  const [s] = await tx.$queryRaw<Array<{ status: string; tokenVersion: number }>>`
    SELECT status::text AS status, "tokenVersion" FROM "ShopifyStore" WHERE id = ${o.storeId} FOR SHARE`
  if (!s || s.status !== 'ACTIVE' || s.tokenVersion !== o.tokenVersion) return false
  const afectados = enlaces.filter(l => o.locationLinkId === undefined || o.generation === undefined || l.generation === o.generation)
  if (afectados.length === 0) return false
  const nuevos = afectados.filter(l => l.importError !== 'FALTA_PERMISO')
  if (nuevos.length === 0) return true
  await tx.shopifyLocationLink.updateMany({ where: { id: { in: nuevos.map(l => l.id) } }, data: { importError: 'FALTA_PERMISO' } })
  for (const l of nuevos) await notifyShopify(l.venueId, 'FALTA_PERMISO')
  return true
}

// ─── Suspender ──────────────────────────────────────────────────────────────────────────────────────────────

const MOTIVO_DE_NIVEL: Record<'SIN_NIVEL' | 'NO_RASTREADO', ShopifySuspendReason> = {
  SIN_NIVEL: 'NIVEL_INEXISTENTE',
  NO_RASTREADO: 'NO_RASTREADO',
}
const ISSUE_DE: Record<ShopifySuspendReason, ShopifyIssueReason> = {
  SIN_INVENTARIO: 'SIN_INVENTARIO',
  NIVEL_INEXISTENTE: 'NIVEL_INEXISTENTE',
  NO_RASTREADO: 'NO_RASTREADO',
}

// ─── ¿Se puede sincronizar este producto? (FF-I1) ───────────────────────────────────────────────────────────

/** Por qué un producto no se sincroniza con Shopify (R-M2: es el motivo que ve el dueño en «Productos sin pareja»). */
export type MotivoNoSincronizable = 'TIPO_SIN_INVENTARIO' | 'METODO_RECETA' | 'SIN_INVENTARIO_EN_AVOQADO' | 'UNIDAD_NO_PIEZA'
const MOTIVOS_NO_SINCRONIZABLE: MotivoNoSincronizable[] = [
  'TIPO_SIN_INVENTARIO',
  'METODO_RECETA',
  'SIN_INVENTARIO_EN_AVOQADO',
  'UNIDAD_NO_PIEZA',
]
/**
 * Los motivos de «Productos sin pareja» que deja `suspendPair` (los de nivel y, para `SIN_INVENTARIO`, el motivo real del
 * producto, R-M2); los limpia quien reactiva la pareja (A y la resolución de B).
 */
export const MOTIVOS_DE_SUSPENSION: ShopifyIssueReason[] = [
  'SIN_INVENTARIO',
  'NIVEL_INEXISTENTE',
  'NO_RASTREADO',
  ...MOTIVOS_NO_SINCRONIZABLE,
]

const UNIDADES_PIEZA: string[] = ['UNIT', 'PIECE']
type ProductoSincronizable = {
  type: string
  trackInventory: boolean
  inventoryMethod: string | null
  unit: string | null
  /** P1-2: la venta de un producto por peso descuenta kilos (`weightQuantity`) aunque su unidad diga pieza. */
  soldByWeight: boolean
}

/**
 * Lo que impide sincronizar con Shopify el inventario de un producto (tipo, método, seguimiento, unidad); `null` =
 * elegible: por cantidad (`trackInventory` + `QUANTITY`), de un tipo que lleva existencias y por pieza (ni otra unidad ni
 * «se vende por peso»: el PATCH móvil prende `soldByWeight` sin forzar `KILOGRAM`, y la venta descuenta kilos). Es UNA regla: la
 * usan el catálogo al ligar y el espejo al iniciar, aplicar o reactivar una pareja. Una fila de `Inventory` no basta:
 * `setProductInventoryMethod(…)` la conserva al pasar a receta, y con ella el cuadre revivía la pareja (Shopify sobrevendía).
 */
export function motivoNoSincronizable(p: ProductoSincronizable): MotivoNoSincronizable | null {
  if (isNonInventoriable(p.type, true)) return 'TIPO_SIN_INVENTARIO'
  if (p.inventoryMethod === 'RECIPE') return 'METODO_RECETA'
  if (!p.trackInventory || p.inventoryMethod !== 'QUANTITY') return 'SIN_INVENTARIO_EN_AVOQADO'
  if (p.soldByWeight || (p.unit && !UNIDADES_PIEZA.includes(p.unit))) return 'UNIDAD_NO_PIEZA'
  return null
}

/**
 * El producto de una pareja, leído con la pareja YA bloqueada. Lectura sin candado a propósito: `Product` va ANTES que la
 * sucursal en el orden (§10.3) y tomarlo aquí lo invertiría. Alcanza porque quien vuelve inelegible a un producto ligado
 * (pasar a receta, por cualquier camino) escribe el `Product` y DESPUÉS suspende la pareja bajo su candado
 * (`suspenderParejaPorReceta`): si esta tx vio el producto de antes y reactivó, aquélla la suspende en cuanto la suelta.
 * `archivadoConEnvio` es U3: un producto que el conector archivó con un envío en camino conserva `NIVEL_INEXISTENTE`.
 * R-M2: si ya estaba suspendida por esto y el motivo cambió (de receta a kilos, por ejemplo), la incidencia se pone al día:
 * «Productos sin pareja» dice siempre el motivo de hoy.
 */
export async function sincronizableBajoCandado(
  tx: Prisma.TransactionClient,
  p: { productId: string; suspendedReason: ShopifySuspendReason | null; venueId: string; shopifyVariantId: string },
): Promise<{ motivo: MotivoNoSincronizable | null; dejarComoEsta: boolean }> {
  const prod = await tx.product.findUnique({
    where: { id: p.productId },
    select: { type: true, trackInventory: true, inventoryMethod: true, unit: true, soldByWeight: true, deletedAt: true, deletedBy: true },
  })
  if (!prod) return { motivo: 'SIN_INVENTARIO_EN_AVOQADO', dejarComoEsta: true }
  const motivo = motivoNoSincronizable(prod)
  const archivadoConEnvio =
    p.suspendedReason === 'NIVEL_INEXISTENTE' && !!prod.deletedAt && prod.deletedBy === SHOPIFY_SERVICE_ACTOR.servicePrincipalId
  // Ya suspendida por esto (cada cuadre pasa por aquí mientras siga en receta): sólo se pone al día el motivo, si cambió.
  if (motivo && p.suspendedReason === 'SIN_INVENTARIO') {
    await tx.shopifyImportIssue.updateMany({
      where: { venueId: p.venueId, shopifyVariantId: p.shopifyVariantId, reason: { in: MOTIVOS_DE_SUSPENSION, not: motivo } },
      data: { reason: motivo, detail: DETALLE_NO_SINCRONIZABLE[motivo] },
    })
  }
  return { motivo, dejarComoEsta: p.suspendedReason === 'SIN_INVENTARIO' || archivadoConEnvio }
}
const DETALLE: Record<ShopifySuspendReason, string> = {
  SIN_INVENTARIO:
    'Este producto ya no tiene inventario en Avoqado. La sincronización con Shopify quedó en pausa para él; se reanuda sola cuando vuelva a tenerlo.',
  NIVEL_INEXISTENTE:
    'La variante no está activa en la ubicación de Shopify de esta sucursal. Actívala en Shopify y se reanuda sola en el siguiente cuadre.',
  NO_RASTREADO:
    'Shopify no lleva el inventario de esta variante («Rastrear cantidad» apagado). Enciéndelo en Shopify y se reanuda sola en el siguiente cuadre.',
}
/** R-M2: el texto de una pareja suspendida `SIN_INVENTARIO` porque su producto ya no se sincroniza, por motivo. */
const DETALLE_NO_SINCRONIZABLE: Record<MotivoNoSincronizable, string> = {
  METODO_RECETA:
    'Este producto pasó a receta en Avoqado y Shopify sólo sincroniza productos contados por pieza. La sincronización quedó en pausa para él; se reanuda sola si vuelve a contarse por cantidad.',
  UNIDAD_NO_PIEZA:
    'Este producto se mide en otra unidad en Avoqado (kilos, litros) y Shopify sólo cuenta piezas. La sincronización quedó en pausa para él; se reanuda sola si vuelve a contarse por pieza.',
  TIPO_SIN_INVENTARIO:
    'Este producto es de un tipo que no lleva inventario en Avoqado (como un servicio o una clase). La sincronización con Shopify quedó en pausa para él.',
  SIN_INVENTARIO_EN_AVOQADO:
    'Este producto ya no lleva control de existencias en Avoqado. La sincronización con Shopify quedó en pausa para él; se reanuda sola al volver a activarle el inventario por cantidad.',
}

/**
 * Pone la pareja en pausa con su motivo y la deja en «Productos sin pareja». Descarta SÓLO lo que nunca llegó a Shopify
 * (PENDING/FAILED no ambiguas). Una IN_PROGRESS o una ambigua sigue viva: es la barrera de un envío que pudo aplicarse y
 * sólo se resuelve con su misma llave (§9.1). Nunca escribe stock ni espejo. R-M2: con `SIN_INVENTARIO` y el motivo del
 * producto (`motivoNoSincronizable`), la incidencia lleva ESE motivo y su texto (receta, unidad, tipo o sin seguimiento);
 * la pareja sigue `SIN_INVENTARIO`, que es lo que lee el resto del conector.
 */
export async function suspendPair(
  tx: Prisma.TransactionClient,
  variantLinkId: string,
  reason: ShopifySuspendReason,
  motivo: MotivoNoSincronizable | null = null,
): Promise<void> {
  const issue = reason === 'SIN_INVENTARIO' && motivo ? motivo : ISSUE_DE[reason]
  const detail = reason === 'SIN_INVENTARIO' && motivo ? DETALLE_NO_SINCRONIZABLE[motivo] : DETALLE[reason]
  const ahora = new Date()
  const p = await tx.shopifyVariantLink.update({
    where: { id: variantLinkId },
    data: { suspendedReason: reason, suspendedAt: ahora },
    select: {
      venueId: true,
      productId: true,
      locationLinkId: true,
      shopifyVariantId: true,
      shopifyProductId: true,
      originalSku: true,
      locationLink: { select: { generation: true } },
      product: { select: { name: true, sku: true } },
    },
  })
  await tx.shopifyStockOutbox.updateMany({
    where: {
      productId: p.productId,
      locationLinkId: p.locationLinkId,
      generation: p.locationLink.generation,
      status: { in: ['PENDING', 'FAILED'] },
      ambiguous: false,
    },
    data: { status: 'DISCARDED', lastError: 'PAREJA_SUSPENDIDA', processedAt: ahora, claimToken: null, leaseUntil: null },
  })
  await tx.shopifyImportIssue.upsert({
    where: { venueId_shopifyVariantId: { venueId: p.venueId, shopifyVariantId: p.shopifyVariantId } },
    create: {
      venueId: p.venueId,
      shopifyVariantId: p.shopifyVariantId,
      shopifyProductId: p.shopifyProductId,
      title: p.product.name,
      sku: p.originalSku ?? p.product.sku,
      reason: issue,
      detail,
      productId: p.productId,
    },
    update: { reason: issue, detail, title: p.product.name, productId: p.productId },
  })
}

/**
 * Aviso de pieza vendida dos veces (stock negativo en cualquiera de los dos lados). Best-effort de punta a punta (N7): si
 * no se puede leer el nombre, el aviso sale con texto genérico; nunca lanza. Lo usa también el mensajero.
 */
export async function avisarSobreventa(venueId: string, productId: string): Promise<void> {
  let productName: string | undefined
  try {
    productName = (await prisma.product.findUnique({ where: { id: productId }, select: { name: true } }))?.name
  } catch (err) {
    logger.warn(`[SHOPIFY] aviso de sobreventa sin nombre del producto ${productId}: ${(err as Error).message}`)
  }
  await notifyShopify(venueId, 'SOBREVENTA', { productName })
}

// ─── Aplicar lo que cambió en Shopify ───────────────────────────────────────────────────────────────────────

type SalidaAplicar = {
  outcome: ApplyOutcome
  venueId?: string
  productId?: string
  aplicado?: { delta: number; previo: string; nuevo: string }
  negativo?: boolean
}

/**
 * Aplica en Avoqado `disponible − espejo`. Todo en UNA transacción y en este orden (índice §4 con §9.1, §9.7 y §11.2):
 * marca → candados → cerco distinto ⇒ CONTEXTO_CAMBIO → tienda o fase no ACTIVE ⇒ PAUSADO → sin acceso ⇒ PAUSADO →
 * suspendida ⇒ SUSPENDIDO → sin iniciar ⇒ NO_INICIADA → lectura vieja ⇒ REINTENTAR → envío en vuelo ⇒ REINTENTAR,
 * incierto ⇒ INCIERTO → candados de Inventory y de las filas del buzón que puede tocar (§12.5) → evento reclamado por
 * otro ⇒ CONTEXTO_CAMBIO → producto que ya no se sincroniza (FF-I1) ⇒ suspender SIN_INVENTARIO → sin nivel o no rastreado ⇒
 * suspender (nunca cero) → sin Inventory ⇒ suspender SIN mover el espejo → espejo ← (available, committed) SIEMPRE →
 * delta 0 ⇒ SIN_CAMBIO → Inventory += delta con su movimiento ⇒ APLICADO. Ningún efecto antes de comprobar el cerco
 * completo. Después, SOBREVENTA si quedó negativo cualquiera de los dos lados (también en SIN_CAMBIO). Una pareja que
 * ya no existe ⇒ NO_INICIADA.
 */
export async function applyShopifyLevel(
  input: { variantLinkId: string; nivel: NivelLeido; fetchedAt: Date; cause: string },
  deps: Deps = {},
): Promise<ApplyOutcome> {
  const hasAccess = deps.hasAccess ?? accesoReal
  const r = await prisma.$transaction(async (tx): Promise<SalidaAplicar> => {
    await marcarOrigenShopify(tx)
    const p = await bloquearPareja(tx, input.variantLinkId)
    if (!p) return { outcome: 'NO_INICIADA' }
    if (!coincide(p, deps.cerco)) return { outcome: 'CONTEXTO_CAMBIO' }
    if (p.storeStatus !== 'ACTIVE' || p.linkStatus !== 'ACTIVE') return { outcome: 'PAUSADO' }
    if (!(await hasAccess(p.venueId))) return { outcome: 'PAUSADO' }
    if (p.suspendedReason) return { outcome: 'SUSPENDIDO' }
    if (!p.initializedAt) return { outcome: 'NO_INICIADA' }
    if (p.mirrorAt > input.fetchedAt) return { outcome: 'REINTENTAR' }
    const bloqueo = await productBlocked(tx, p.productId, p.locationLinkId, p.generation)
    if (bloqueo === 'EN_VUELO') return { outcome: 'REINTENTAR' }
    if (bloqueo === 'INCIERTO') return { outcome: 'INCIERTO' }
    const inv = await bloquearInventario(tx, p.productId)
    await bloquearFilasDelProducto(tx, p, false) // suspender puede descartar las que nunca salieron
    // Otra vez, ya con las filas bloqueadas: una que alguien pasó a IN_PROGRESS (o marcó ambigua) entre la primera
    // revisión y este candado se quedó fuera de él, y aplicar ahora la contaría dos veces.
    const bloqueoBajoCandado = await productBlocked(tx, p.productId, p.locationLinkId, p.generation)
    if (bloqueoBajoCandado === 'EN_VUELO') return { outcome: 'REINTENTAR' }
    if (bloqueoBajoCandado === 'INCIERTO') return { outcome: 'INCIERTO' }
    if (!(await eventoVigente(tx, deps.cerco?.evento))) return { outcome: 'CONTEXTO_CAMBIO' }
    // FF-I1: un producto que ya no se sincroniza (receta con su fila de Inventory, sin seguimiento…) se suspende como si no
    // tuviera Inventory: lo que llegue de Shopify ya no le toca.
    const { motivo } = await sincronizableBajoCandado(tx, p)
    if (motivo) {
      await suspendPair(tx, p.id, 'SIN_INVENTARIO', motivo)
      return { outcome: 'SUSPENDIDO' }
    }
    if (input.nivel.kind !== 'OK') {
      await suspendPair(tx, p.id, MOTIVO_DE_NIVEL[input.nivel.kind])
      return { outcome: 'SUSPENDIDO' }
    }
    if (!inv) {
      await suspendPair(tx, p.id, 'SIN_INVENTARIO')
      return { outcome: 'SUSPENDIDO' }
    }
    const { available, committed } = input.nivel
    const ahora = new Date()
    await tx.shopifyVariantLink.update({
      where: { id: p.id },
      data: { mirrorAvailable: available, mirrorCommitted: committed, mirrorAt: ahora, committedAt: ahora },
    })
    const delta = available - p.mirrorAvailable
    if (delta === 0) {
      return { outcome: 'SIN_CAMBIO', venueId: p.venueId, productId: p.productId, negativo: inv.currentStock.lessThan(0) || available < 0 }
    }
    const nuevo = inv.currentStock.plus(delta)
    await tx.inventory.update({ where: { id: inv.id }, data: { currentStock: { increment: delta } } })
    await tx.inventoryMovement.create({
      data: {
        inventoryId: inv.id,
        type: 'ADJUSTMENT',
        quantity: new Prisma.Decimal(delta),
        previousStock: inv.currentStock,
        newStock: nuevo,
        reason: `Shopify: ${input.cause}`,
        createdBy: null,
      },
    })
    return {
      outcome: 'APLICADO',
      venueId: p.venueId,
      productId: p.productId,
      aplicado: { delta, previo: inv.currentStock.toString(), nuevo: nuevo.toString() },
      negativo: nuevo.lessThan(0) || available < 0,
    }
  })
  if (r.aplicado && r.venueId && r.productId) {
    logAction({
      venueId: r.venueId,
      action: 'SHOPIFY_STOCK_APPLIED',
      entity: 'Product',
      entityId: r.productId,
      data: { ...r.aplicado, causa: input.cause },
    })
  }
  if (r.negativo && r.venueId && r.productId) await avisarSobreventa(r.venueId, r.productId)
  return r.outcome
}

// ─── Iniciar una pareja ─────────────────────────────────────────────────────────────────────────────────────

/**
 * TOMAR_SHOPIFY: Inventory = S + pendientes, espejo = S. Vale para cualquier pareja sin iniciar en REVIEWING con
 * «Aplicar» pedido (el dueño vio la vista previa), y en ACTIVE sólo si el catálogo CREÓ el producto (`createdProduct`,
 * §9.6). COMPARAR (sólo ACTIVE; pareja sin iniciar o suspendida): descarta lo pendiente y lo atorado del producto,
 * espejo = S, Inventory intacto y, si difiere, abre «Por revisar» REACTIVADA con `offset = Inventory − S` (§9.3); si ya
 * coinciden, cierra la revisión OPEN del producto (§11.8). Los dos esperan (REINTENTAR) mientras el producto tenga un
 * envío en vuelo o incierto (§9.1), y con un cerco distinto ⇒ CONTEXTO_CAMBIO sin efectos (§11.2). Una pareja viva ⇒
 * NO_APLICA. FF-I1: un producto que ya no se sincroniza (`motivoNoSincronizable`) nunca se inicia ni se reactiva: la
 * pareja queda SIN_INVENTARIO (SUSPENDIDA), sin esperar envíos, aunque el producto conserve su fila de Inventory.
 */
export async function initializePair(
  input: { variantLinkId: string; nivel: NivelLeido; fetchedAt: Date; mode: 'TOMAR_SHOPIFY' | 'COMPARAR' },
  deps: Deps = {},
): Promise<InitOutcome> {
  const hasAccess = deps.hasAccess ?? accesoReal
  const tomar = input.mode === 'TOMAR_SHOPIFY'
  type R = { outcome: InitOutcome; venueId?: string; productId?: string; cambio?: { previo: string; nuevo: string }; negativo?: boolean }
  const r = await prisma.$transaction(async (tx): Promise<R> => {
    await marcarOrigenShopify(tx)
    const p = await bloquearPareja(tx, input.variantLinkId)
    if (!p) return { outcome: 'NO_APLICA' }
    if (!coincide(p, deps.cerco)) return { outcome: 'CONTEXTO_CAMBIO' }
    if (p.storeStatus !== 'ACTIVE') return { outcome: 'NO_APLICA' }
    if (!(await hasAccess(p.venueId))) return { outcome: 'NO_APLICA' }
    const sinIniciar = !p.initializedAt && !p.suspendedReason
    const elegible = tomar
      ? sinIniciar && ((p.linkStatus === 'REVIEWING' && p.applyRequestedAt !== null) || (p.linkStatus === 'ACTIVE' && p.createdProduct))
      : p.linkStatus === 'ACTIVE' && (!p.initializedAt || !!p.suspendedReason)
    if (!elegible) return { outcome: 'NO_APLICA' }
    // FF-I1: un producto que ya no se sincroniza nunca se inicia ni se reactiva, aunque conserve su fila de Inventory
    // (pasar a receta por setProductInventoryMethod la deja). No espera a ningún envío: suspender conserva la barrera.
    const sincronizable = await sincronizableBajoCandado(tx, p)
    if (sincronizable.motivo) {
      if (sincronizable.dejarComoEsta) return { outcome: 'SUSPENDIDA' } // ya lo está (o es U3): nada que reescribir
      await bloquearInventario(tx, p.productId) // §10.3 y §12.5: pareja → Inventory → filas, antes del evento
      await bloquearFilasDelProducto(tx, p, false)
      if (!(await eventoVigente(tx, deps.cerco?.evento))) return { outcome: 'CONTEXTO_CAMBIO' }
      await suspendPair(tx, p.id, 'SIN_INVENTARIO', sincronizable.motivo)
      return { outcome: 'SUSPENDIDA' }
    }
    if (p.mirrorAt > input.fetchedAt) return { outcome: 'REINTENTAR' }
    if ((await productBlocked(tx, p.productId, p.locationLinkId, p.generation)) !== 'LIBRE') return { outcome: 'REINTENTAR' }
    const inv = await bloquearInventario(tx, p.productId)
    await bloquearFilasDelProducto(tx, p, !tomar) // COMPARAR descarta filas y abre o cierra la revisión
    // Otra vez, ya con las filas bloqueadas (ver applyShopifyLevel): una fila en vuelo que se coló aquí no se descarta y
    // su envío movería el espejo encima del offset nuevo.
    if ((await productBlocked(tx, p.productId, p.locationLinkId, p.generation)) !== 'LIBRE') return { outcome: 'REINTENTAR' }
    if (!(await eventoVigente(tx, deps.cerco?.evento))) return { outcome: 'CONTEXTO_CAMBIO' }
    if (input.nivel.kind !== 'OK') {
      await suspendPair(tx, p.id, MOTIVO_DE_NIVEL[input.nivel.kind])
      return { outcome: 'SUSPENDIDA' }
    }
    if (!inv) {
      await suspendPair(tx, p.id, 'SIN_INVENTARIO')
      return { outcome: 'SUSPENDIDA' }
    }
    const ahora = new Date()
    const S = input.nivel.available
    await tx.shopifyVariantLink.update({
      where: { id: p.id },
      data: {
        mirrorAvailable: S,
        mirrorCommitted: input.nivel.committed,
        mirrorAt: ahora,
        committedAt: ahora,
        initializedAt: ahora,
        suspendedReason: null,
        suspendedAt: null,
      },
    })
    await tx.shopifyImportIssue.deleteMany({
      where: { venueId: p.venueId, shopifyVariantId: p.shopifyVariantId, reason: { in: MOTIVOS_DE_SUSPENSION } },
    })
    const base = { venueId: p.venueId, productId: p.productId }

    if (tomar) {
      const objetivo = (await liveOutboxSum(tx, p.productId, p.locationLinkId, p.generation)).plus(S)
      const delta = objetivo.minus(inv.currentStock)
      const negativo = objetivo.lessThan(0) || S < 0
      if (delta.isZero()) return { outcome: 'INICIADA', ...base, negativo }
      await tx.inventory.update({ where: { id: inv.id }, data: { currentStock: objetivo } })
      await tx.inventoryMovement.create({
        data: {
          inventoryId: inv.id,
          type: 'ADJUSTMENT',
          quantity: delta,
          previousStock: inv.currentStock,
          newStock: objetivo,
          reason: 'Shopify: inicio de sincronización',
          createdBy: null,
        },
      })
      return { outcome: 'INICIADA', ...base, negativo, cambio: { previo: inv.currentStock.toString(), nuevo: objetivo.toString() } }
    }

    // COMPARAR re-arranca la cuenta. Como el producto está LIBRE, todo lo que queda es lo que nunca llegó o lo atorado sin
    // duda: se descarta y el offset de la revisión lo absorbe, así el invariante sigue cuadrando.
    await tx.shopifyStockOutbox.updateMany({
      where: {
        productId: p.productId,
        locationLinkId: p.locationLinkId,
        generation: p.generation,
        status: { in: ['PENDING', 'FAILED', 'DEAD_LETTER'] },
      },
      data: { status: 'DISCARDED', lastError: 'PAREJA_REACTIVADA', processedAt: ahora, claimToken: null, leaseUntil: null },
    })
    const negativo = inv.currentStock.lessThan(0) || S < 0
    if (inv.currentStock.equals(S)) {
      // Ya cuadran: una revisión que seguía abierta ya no explica nada (§11.8); si quedara, su offset rompería el invariante.
      await tx.shopifyReviewItem.updateMany({
        where: { productId: p.productId, status: 'OPEN' },
        data: { status: 'RESOLVED', offset: new Prisma.Decimal(0), resolvedAt: ahora },
      })
      return { outcome: 'INICIADA', ...base, negativo }
    }
    const datos = {
      reason: 'REACTIVADA' as const,
      // W5: la pareja nunca se había iniciado y el producto NO lo creó el conector ⇒ ya existía en Avoqado y se liga por
      // PRIMERA vez. Una creada por el conector, suspendida en su primer inicio y reactivada después, no es eso (ronda 2).
      firstPairing: !p.initializedAt && !p.createdProduct,
      avoqadoQty: inv.currentStock,
      shopifyQty: S,
      atorados: 0,
      offset: inv.currentStock.minus(S),
      suggestion: 'SHOPIFY' as const,
    }
    const abierta = await tx.shopifyReviewItem.findFirst({ where: { productId: p.productId, status: 'OPEN' }, select: { id: true } })
    if (abierta) await tx.shopifyReviewItem.update({ where: { id: abierta.id }, data: datos })
    else await tx.shopifyReviewItem.create({ data: { venueId: p.venueId, productId: p.productId, ...datos } })
    return { outcome: 'EN_REVISION', ...base, negativo }
  })
  if (r.cambio && r.venueId && r.productId) {
    logAction({ venueId: r.venueId, action: 'SHOPIFY_STOCK_INITIALIZED', entity: 'Product', entityId: r.productId, data: r.cambio })
  }
  if (r.outcome === 'EN_REVISION' && r.venueId) await notifyShopify(r.venueId, 'POR_REVISAR', { count: 1 })
  if (r.negativo && r.venueId && r.productId) await avisarSobreventa(r.venueId, r.productId)
  return r.outcome
}
