// src/services/commerce-channels/shopify/shopify.catalog.service.ts
/**
 * El traductor (spec §4 ②, 12 bis.13; plan v2 B1): cada variante de Shopify es un producto plano de Avoqado.
 * - Empareja por SKU y por código de barras; si apuntan a productos distintos, no liga. Nunca liga archivados por el
 *   dueño, de receta, tipos sin inventario, sin inventario por piezas ni con unidad distinta de pieza, y nunca los
 *   convierte (#11). Lo que no se trae queda en «Productos sin pareja» con su motivo.
 * - Cada variante, en UNA transacción y en el orden §10.3: candado de gobierno (precondición de todo upsert, N08) →
 *   Product por id, `FOR NO KEY UPDATE` (N07, K11: no frena a las ventas) → sucursal y tienda con el cerco del contexto
 *   y el plan (N05, #14) → pareja (`bloquearPareja` de A, BR-6) → reclamo del evento, el ÚLTIMO (`FOR SHARE`, §11.2).
 * - El stock no lo toca nunca: la pareja nace sin iniciar; la inicia la conexión (TOMAR_SHOPIFY) o el sync y el cuadre
 *   (TOMAR si el catálogo CREÓ el producto, COMPARAR si ya existía, §9.6).
 * - Archivar conserva la barrera de un envío en camino (§10.4, N01).
 */
import { Prisma, type ShopifyIssueReason } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { generateSlug } from '@/utils/slugify'
import { logAction } from '@/services/dashboard/activity-log.service'
import { archivarProductos } from '@/services/dashboard/product.dashboard.service'
import { ensureQuantityInventoryRow } from '@/services/dashboard/quantityInventoryRow'
import {
  assertLegacyCatalogGovernanceForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '@/services/master-catalog/catalogGovernance.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { CATALOG_PAGE_SIZE, SHOPIFY_FEATURE, SHOPIFY_MAX_VARIANTS, SHOPIFY_SERVICE_ACTOR } from './shopify.constants'
import { shopifyGraphql, type ShopifyResult } from './shopify.graphql'
import {
  bloquearPareja,
  initializePair,
  marcarOrigenShopify,
  motivoNoSincronizable,
  SHOPIFY_IMPORT_ERRORES_TERMINALES,
  suspendPair,
  type CercoShopify,
  type NivelLeido,
} from './shopify.mirror.service'
import {
  atenderFalla,
  conVencimiento,
  ContextoObsoleto,
  envioEnCamino,
  exigirCerco,
  FALTA_PERMISO,
  leerToken,
  MIN_ESCRITURA_MS,
  pedirCuadre,
  restante,
  SIN_TIEMPO,
  TOKEN_ILEGIBLE,
  verificarEvento,
} from './shopify.store.service'

/** `deletedBy` de lo que archiva el conector: sólo eso se restaura solo cuando la variante vuelve. */
export const ARCHIVADO_POR_SHOPIFY = 'SHOPIFY_SYNC'
/** Más de 20,000 variantes: no se conecta en esta versión (12 bis.12). La página lo explica. */
export const CATALOGO_MUY_GRANDE = 'CATALOGO_MUY_GRANDE'
/** La organización pasó a catálogo maestro ENFORCED: el conector no se soporta ahí (spec §3). */
export const CATALOGO_MAESTRO = 'CATALOGO_MAESTRO'
// Los `importError` terminales (FALTA_PERMISO, CATALOGO_MUY_GRANDE, CATALOGO_MAESTRO) son la lista de A,
// `SHOPIFY_IMPORT_ERRORES_TERMINALES` (§12.2): una sola, la misma que usan su cerco y su reclamo del buzón.
/**
 * En MINÚSCULAS y con OR: medido en vivo (C10, API 2026-10), con mayúsculas Shopify devuelve 0 variantes (la tienda se
 * conectaba vacía); `(product_status:active OR product_status:draft)` trae las ACTIVE y DRAFT sin la archivada, también
 * detrás de `product_id:N`. Es la única fuente del filtro: una prueba falla si otro código escribe `product_status:` a mano.
 */
export const FILTRO_ESTADO = '(product_status:active OR product_status:draft)'
const MAX_INTENTOS_IMPORTACION = 5
/** 2,500 variantes: más que el tope de Shopify por producto (2,048). */
const MAX_PAGINAS_PRODUCTO = 50
/** El código de barras de Avoqado admite 14 caracteres (EAN-13, UPC-12, GTIN-14). */
const GTIN_MAX = 14
/** Shopify rechaza cantidades fuera de ±2,000,000,000: fuera de eso no es un dato real (igual que A). */
const MAX_CANTIDAD = 2_000_000_000
const TANDA = 50

export type VarianteShopify = {
  id: string
  sku: string | null
  selectedOptions: Array<{ name: string; value: string }>
  barcodes: { nodes: Array<{ value: string }> }
  contextualPricing: { price: { amount: string; currencyCode: string } | null } | null
  media: { nodes: Array<{ preview: { image: { url: string } | null } | null }> }
  product: {
    id: string
    title: string
    productType: string
    status: string
    featuredMedia: { preview: { image: { url: string } | null } | null } | null
  }
  inventoryItem: {
    id: string
    tracked: boolean
    inventoryLevel: { isActive: boolean; quantities: Array<{ name: string; quantity: number }> } | null
  }
}
export type PaginaVariantes = {
  /** Sólo en la primera página de la carga inicial (12 bis.12). */
  total?: { count: number } | null
  productVariants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: VarianteShopify[] }
}

export const QUERY_VARIANTES = `query Variantes($first: Int!, $after: String, $query: String!, $loc: ID!, $conteo: Boolean!, $limite: Int!) {
  total: productVariantsCount(limit: $limite) @include(if: $conteo) { count }
  productVariants(first: $first, after: $after, query: $query, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      selectedOptions { name value }
      barcodes(first: 1) { nodes { value } }
      contextualPricing(context: { country: MX }) { price { amount currencyCode } }
      media(first: 1) { nodes { preview { image { url } } } }
      product { id title productType status featuredMedia { preview { image { url } } } }
      inventoryItem { id tracked inventoryLevel(locationId: $loc) { isActive quantities(names: ["available", "committed"]) { name quantity } } }
    }
  }
}`

// ─── Validación estricta (N06) ──────────────────────────────────────────────────────────────────────────────

const texto = (x: unknown): x is string => typeof x === 'string'
const gid = (x: unknown, tipo: string): boolean =>
  texto(x) && x.startsWith(`gid://shopify/${tipo}/`) && x.length > `gid://shopify/${tipo}/`.length
function cantidadValida(q: unknown[], name: string): boolean {
  const del = q.filter(x => (x as { name?: unknown } | null)?.name === name) as Array<{ quantity?: unknown }>
  return del.length === 1 && Number.isSafeInteger(del[0].quantity) && Math.abs(del[0].quantity as number) <= MAX_CANTIDAD
}
/** `null` o `{ preview: null | { image: null | { url } } }`. */
function imagen(m: unknown): boolean {
  if (m === null) return true
  if (typeof m !== 'object' || m === undefined) return false
  const preview = (m as { preview?: unknown }).preview
  if (preview === null) return true
  if (typeof preview !== 'object' || preview === undefined) return false
  const image = (preview as { image?: unknown }).image
  return image === null || texto((image as { url?: unknown } | undefined)?.url)
}
function varianteValida(n: unknown, productId?: string): boolean {
  const v = n as Partial<Record<keyof VarianteShopify, unknown>> | null
  if (!v || !gid(v.id, 'ProductVariant')) return false
  if (!(v.sku === null || texto(v.sku))) return false
  if (!Array.isArray(v.selectedOptions) || !v.selectedOptions.every(o => texto(o?.name) && texto(o?.value))) return false
  const codigos = (v.barcodes as { nodes?: unknown } | undefined)?.nodes
  if (!Array.isArray(codigos) || !codigos.every(c => texto(c?.value))) return false
  const medios = (v.media as { nodes?: unknown } | undefined)?.nodes
  if (!Array.isArray(medios) || !medios.every(imagen)) return false
  const precio = (v.contextualPricing as { price?: unknown } | null | undefined)?.price
  if (
    v.contextualPricing !== null &&
    !(precio === null || (texto((precio as { amount?: unknown })?.amount) && texto((precio as { currencyCode?: unknown })?.currencyCode)))
  )
    return false
  const p = v.product as Partial<VarianteShopify['product']> | undefined
  if (!p || !gid(p.id, 'Product') || !texto(p.title) || !texto(p.productType) || !texto(p.status)) return false
  if (!(p.featuredMedia === null || imagen(p.featuredMedia))) return false
  if (productId && p.id !== productId) return false
  const item = v.inventoryItem as { id?: unknown; tracked?: unknown; inventoryLevel?: unknown } | undefined
  if (!item || !gid(item.id, 'InventoryItem') || typeof item.tracked !== 'boolean') return false
  if (item.inventoryLevel === null) return true
  const lvl = item.inventoryLevel as { isActive?: unknown; quantities?: unknown } | undefined
  if (typeof lvl?.isActive !== 'boolean' || !Array.isArray(lvl.quantities)) return false
  return !lvl.isActive || (cantidadValida(lvl.quantities, 'available') && cantidadValida(lvl.quantities, 'committed'))
}

/**
 * La página entera tiene la forma que pedimos: conteo en la primera página, cursor que avanza si hay otra, ids únicos,
 * variantes del producto pedido (sync) y cantidades reales. Si no, A la convierte en BAD_RESPONSE y no se toca nada.
 */
export const paginaValida =
  (p: { cursor: string | null; conteo: boolean; productId?: string }) =>
  (d: unknown): d is PaginaVariantes => {
    const pv = (d as { productVariants?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } } } | null)
      ?.productVariants
    if (!pv || !Array.isArray(pv.nodes) || pv.nodes.length > CATALOG_PAGE_SIZE) return false
    const siguiente = pv.pageInfo?.hasNextPage
    if (typeof siguiente !== 'boolean') return false
    if (
      siguiente &&
      (!texto(pv.pageInfo?.endCursor) || pv.pageInfo?.endCursor === '' || pv.pageInfo?.endCursor === p.cursor || pv.nodes.length === 0)
    )
      return false
    const ids = new Set<string>()
    for (const n of pv.nodes) {
      if (!varianteValida(n, p.productId)) return false
      ids.add((n as VarianteShopify).id)
    }
    if (ids.size !== pv.nodes.length) return false
    if (p.conteo) {
      const c = (d as { total?: { count?: unknown } | null }).total?.count
      if (!Number.isSafeInteger(c) || (c as number) < 0) return false
    }
    return true
  }

// ─── Confirmar una baja con una lectura directa (FF-I2) ──────────────────────────────────────────────────────

/**
 * FF-I2: la lectura DIRECTA con que se confirma una baja antes de archivar. `nodes(ids:)` no busca: contesta por id, así
 * que un filtro de búsqueda que devuelve 0 en silencio (C10) no puede hacer pasar por borrado un producto que sigue en
 * la tienda.
 */
export const QUERY_CONFIRMAR_BAJAS = `query ConfirmarBajas($ids: [ID!]!) {
  nodes(ids: $ids) { ... on ProductVariant { id product { id status } } }
}`
type NodoBaja = { id: string; product: { id: string; status: string } } | null
/** En el orden pedido: `null` (ya no existe) o la variante PEDIDA en esa posición con su producto y su estado. */
const respuestaBajasDe =
  (pedidos: string[]) =>
  (d: unknown): d is { nodes: NodoBaja[] } => {
    const nodes = (d as { nodes?: unknown } | null)?.nodes
    return (
      Array.isArray(nodes) &&
      nodes.length === pedidos.length &&
      nodes.every((n, i) => {
        if (n === null) return true
        const x = n as { id?: unknown; product?: { id?: unknown; status?: unknown } | null }
        return x.id === pedidos[i] && gid(x.product?.id, 'Product') && texto(x.product?.status)
      })
    )
  }
const POR_CONFIRMACION = 50

/**
 * De las variantes que una búsqueda NO trajo, las que Shopify confirma por id que ya no existen o cuyo producto está
 * ARCHIVED: sólo ésas se archivan. Una que sigue (ACTIVE, DRAFT o cualquier otro estado) no es baja: la búsqueda falló.
 * `graphql` ya viene con el vencimiento de la unidad (`conVencimiento`); una falla (o `SIN_TIEMPO`) sale tal cual y nada
 * se archiva.
 */
export async function confirmarBajas(
  shopDomain: string,
  token: string,
  variantIds: string[],
  graphql: typeof shopifyGraphql,
): Promise<ShopifyResult<Set<string>>> {
  const bajas = new Set<string>()
  for (let i = 0; i < variantIds.length; i += POR_CONFIRMACION) {
    const ids = variantIds.slice(i, i + POR_CONFIRMACION)
    const r = await graphql<{ nodes: NodoBaja[] }>(shopDomain, token, QUERY_CONFIRMAR_BAJAS, { ids }, { validate: respuestaBajasDe(ids) })
    if (!r.ok) return r
    r.data.nodes.forEach((n, j) => {
      if (n === null || n.product.status === 'ARCHIVED') bajas.add(ids[j])
    })
  }
  return { ok: true, data: bajas }
}

/** Los caracteres que `SKU_REGEX` no acepta se vuelven «-»; el original queda en `originalSku` de la pareja. */
export function normalizeSku(raw: string | null | undefined): string | null {
  const s = (raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return s.length > 0 ? s : null
}

const nombreDe = (v: VarianteShopify): string =>
  [v.product.title, ...v.selectedOptions.map(o => o.value).filter(x => x && x !== 'Default Title')].join(' · ')
// ponytail: un código de más de 14 caracteres no cabe en el de Avoqado; se importa sin código. Si aparece, ampliar `gtin`.
const gtinDe = (v: VarianteShopify): string | null => {
  const g = v.barcodes.nodes[0]?.value?.trim() ?? ''
  return g.length > 0 && g.length <= GTIN_MAX ? g : null
}
/** La imagen de la talla antes que la del producto (#20); sin ninguna, null (quitarla en Shopify la quita aquí). */
const imagenDe = (v: VarianteShopify): string | null =>
  v.media.nodes[0]?.preview?.image?.url ?? v.product.featuredMedia?.preview?.image?.url ?? null
/** El precio en pesos del mercado México (spec 12.3); sólo cuenta si es MXN y mayor que cero. */
function precioMxn(v: VarianteShopify): Prisma.Decimal | null {
  const p = v.contextualPricing?.price
  if (!p || p.currencyCode !== 'MXN') return null
  try {
    const d = new Prisma.Decimal(p.amount)
    return d.gt(0) ? d : null
  } catch {
    return null
  }
}

/** El nivel que trae la página (ya validada): nunca un cero inventado (12 bis.4). */
export function nivelDeVariante(v: VarianteShopify): NivelLeido {
  if (!v.inventoryItem.tracked) return { kind: 'NO_RASTREADO' }
  const lvl = v.inventoryItem.inventoryLevel
  if (!lvl || !lvl.isActive) return { kind: 'SIN_NIVEL' }
  const q = (name: string) => lvl.quantities.find(x => x.name === name)?.quantity as number
  return { kind: 'OK', available: q('available'), committed: q('committed') }
}

async function anotar(
  tx: Prisma.TransactionClient,
  venueId: string,
  v: VarianteShopify,
  reason: ShopifyIssueReason,
  detail: string | null = null,
  productId: string | null = null,
): Promise<void> {
  const data = { shopifyProductId: v.product.id, title: nombreDe(v), sku: v.sku, reason, detail, productId }
  await tx.shopifyImportIssue.upsert({
    where: { venueId_shopifyVariantId: { venueId, shopifyVariantId: v.id } },
    create: { venueId, shopifyVariantId: v.id, ...data },
    update: data,
  })
}

/** El «tipo de producto» de Shopify como categoría; si viene vacío, «Shopify». */
async function categoriaPara(tx: Prisma.TransactionClient, venueId: string, tipo: string): Promise<string> {
  const name = tipo.trim() || 'Shopify'
  const slug = generateSlug(name) || 'shopify'
  const existente =
    (await tx.menuCategory.findFirst({ where: { venueId, name }, select: { id: true } })) ??
    (await tx.menuCategory.findUnique({ where: { venueId_slug: { venueId, slug } }, select: { id: true } }))
  if (existente) return existente.id
  return (await tx.menuCategory.create({ data: { venueId, name, slug, originSystem: 'SHOPIFY' }, select: { id: true } })).id
}

// ─── Contexto y cerco (N05, §10.8) ──────────────────────────────────────────────────────────────────────────

export type Reclamo = { eventId: string; claimToken: string }
export type ContextoCatalogo = {
  venueId: string
  locationLinkId: string
  /** La sucursal con que se pidió la página: si cambió algo, la respuesta ya no es de esta conexión. */
  generation: number
  storeId: string
  shopifyLocationId: string
  tokenVersion: number
  fase: 'CONNECTING' | 'ACTIVE'
  importando: boolean
  /** Lease del worker (§10.1). Sin él (prueba directa) no se exige. */
  workToken: string | null
  /** Reclamo del evento que trae este cambio (§10.7). */
  reclamo: Reclamo | null
  /** El plan, revisado DENTRO de la tx común (#14). Sin él, el real (`venueHasFeatureAccess`), como en A: nunca abierto. */
  hasAccess?: (venueId: string) => Promise<boolean>
}

export function contextoDe(
  link: { id: string; venueId: string; generation: number; storeId: string; shopifyLocationId: string },
  store: { tokenVersion: number },
  fase: ContextoCatalogo['fase'],
  importando: boolean,
  extra: { workToken?: string | null; reclamo?: Reclamo | null; hasAccess?: (venueId: string) => Promise<boolean> } = {},
): ContextoCatalogo {
  return {
    hasAccess: extra.hasAccess,
    venueId: link.venueId,
    locationLinkId: link.id,
    generation: link.generation,
    storeId: link.storeId,
    shopifyLocationId: link.shopifyLocationId,
    tokenVersion: store.tokenVersion,
    fase,
    importando,
    workToken: extra.workToken ?? null,
    reclamo: extra.reclamo ?? null,
  }
}

/** El acceso efectivo (§9.7) cuando el llamador no lo inyecta: el mismo default que `initializePair` de A. */
const accesoReal = (venueId: string) => venueHasFeatureAccess(venueId, SHOPIFY_FEATURE)

/** El evento de un reclamo, con la forma del cerco de A (§11.2). Sin reclamo, `undefined`: nunca `null` (§12.6, R07). */
const eventoDe = (r: Reclamo | null | undefined): CercoShopify['evento'] => (r ? { id: r.eventId, claimToken: r.claimToken } : undefined)
/** El reclamo sigue siendo de quien procesa; se llama DESPUÉS de los candados del estado (§10.3: el evento es el último). */
const verificarReclamo = (tx: Prisma.TransactionClient, r: Reclamo | null) => verificarEvento(tx, eventoDe(r))

/**
 * Lo que `initializePair`, `applyShopifyLevel` y `archivarPareja` reciben como cerco (§11.2). Lo que falta va como
 * `undefined` (§12.6, R07): A sólo compara el lease o el evento si vienen, así que un evento de catálogo sin lease no
 * choca con el worker que tiene la sucursal.
 */
export function cercoDe(ctx: ContextoCatalogo): CercoShopify {
  return {
    generation: ctx.generation,
    storeId: ctx.storeId,
    shopifyLocationId: ctx.shopifyLocationId,
    tokenVersion: ctx.tokenVersion,
    workToken: ctx.workToken ?? undefined,
    evento: eventoDe(ctx.reclamo),
  }
}

/**
 * Sucursal → tienda `FOR SHARE` y todo lo del contexto igual, y el plan (#14; sin `hasAccess`, el real); si no, la
 * respuesta ya no aplica. Devuelve el barrido. El reclamo del evento NO va aquí: va después de la pareja (§10.3).
 */
async function cercar(tx: Prisma.TransactionClient, ctx: ContextoCatalogo): Promise<{ sweepId: number }> {
  await exigirCerco(tx, ctx.locationLinkId, cercoDe(ctx)) // el mismo cerco que A: sucursal → tienda FOR SHARE
  const [l] = await tx.$queryRaw<Array<{ status: string; catalogSweepId: number }>>`
    SELECT status::text AS status, "catalogSweepId" FROM "ShopifyLocationLink" WHERE id = ${ctx.locationLinkId}`
  if (!l || l.status !== ctx.fase) throw new ContextoObsoleto()
  if (!(await (ctx.hasAccess ?? accesoReal)(ctx.venueId))) throw new ContextoObsoleto()
  return { sweepId: l.catalogSweepId }
}

const SELECCION_CANDIDATO = {
  id: true,
  venueId: true,
  sku: true,
  type: true,
  trackInventory: true,
  inventoryMethod: true,
  unit: true,
  deletedAt: true,
  deletedBy: true,
  originSystem: true,
  shopifyVariantLink: { select: { id: true } },
} satisfies Prisma.ProductSelect
type Candidato = Prisma.ProductGetPayload<{ select: typeof SELECCION_CANDIDATO }>

/**
 * `Product` primero (§10.3), por id ascendente, y releídos YA bloqueados: lo que se decide es lo vigente (N07).
 * `FOR NO KEY UPDATE` (K11, B-3): serializa con otros escritores del catálogo (receta, archivo) sin frenar el
 * `FOR KEY SHARE` de una venta que inserta un renglón con llave foránea al producto.
 */
async function bloquearProductos(tx: Prisma.TransactionClient, ids: Array<string | null | undefined>): Promise<Map<string, Candidato>> {
  const unicos = [...new Set(ids.filter((x): x is string => !!x))].sort()
  if (unicos.length === 0) return new Map()
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id IN (${Prisma.join(unicos)}) ORDER BY id FOR NO KEY UPDATE`
  const filas = await tx.product.findMany({ where: { id: { in: unicos } }, select: SELECCION_CANDIDATO, take: unicos.length })
  return new Map(filas.map(f => [f.id, f]))
}

/**
 * Lo que impide traer el inventario de un producto, aunque esté libre (tipo, método, seguimiento, unidad). Es la MISMA
 * regla con que el espejo inicia, aplica o reactiva una pareja (`motivoNoSincronizable` de A, FF-I1): no se duplica.
 */
const inelegible = (p: Candidato): ShopifyIssueReason | null => motivoNoSincronizable(p)
/**
 * Lo archivó el conector: `deletedBy = SHOPIFY_SYNC`, que sólo escribe él. Sin mirar `originSystem` (FF-I2): un producto
 * que ya era de Avoqado y se ligó (el catálogo del piloto lo subió el cargador CSV, `AVOQADO`) también vuelve.
 */
const archivadoPorShopify = (p: Candidato): boolean => !!p.deletedAt && p.deletedBy === ARCHIVADO_POR_SHOPIFY

/** La elegibilidad va ANTES de restaurar (N07): un archivado por el conector que ya no es elegible se queda archivado. */
function motivoParaNoLigar(p: Candidato, v: VarianteShopify, porSku: boolean): ShopifyIssueReason | 'RESTAURAR' | null {
  if (p.shopifyVariantLink) return porSku ? 'SKU_REPETIDO' : 'CODIGO_REPETIDO'
  if (p.deletedAt && !archivadoPorShopify(p)) return 'PRODUCTO_ARCHIVADO'
  // El SKU de Shopify sólo coincide después de normalizarlo: es OTRO producto de Avoqado que se llama parecido.
  if (porSku && p.originSystem !== 'SHOPIFY' && p.sku !== (v.sku ?? '').trim()) return 'SKU_CHOCA'
  const motivo = inelegible(p)
  if (motivo) return motivo
  return p.deletedAt ? 'RESTAURAR' : null
}

export type ContextoUpsert = ContextoCatalogo
export type UpsertOutcome =
  | { kind: 'CREADO' | 'LIGADO' | 'ACTUALIZADO'; variantLinkId: string; productId: string; iniciada: boolean; creadaPorConector: boolean }
  | { kind: 'PROBLEMA'; reason: ShopifyIssueReason }
  | { kind: 'OBSOLETO' }
type Importado = { importedAvailable?: number | null; importedAt?: Date }
/** Lo que la tx hizo y se registra en la bitácora DESPUÉS de comitear (K18). */
type Efectos = { restaurado?: string }

/** Una sucursal con la que el catálogo trabaja: ACTIVE y sin error terminal (§12.2). Las demás esperan o no se tocan. */
const sucursalTrabajable = (storeId: string): Prisma.ShopifyLocationLinkWhereInput => ({
  storeId,
  status: 'ACTIVE',
  OR: [{ importError: null }, { importError: { notIn: SHOPIFY_IMPORT_ERRORES_TERMINALES } }],
})

/** §10.3: `Inventory` va después de la pareja y antes de las filas del buzón (como en A). */
async function bloquearInventario(tx: Prisma.TransactionClient, productId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Inventory" WHERE "productId" = ${productId} FOR UPDATE`
}

/**
 * §12.5: las filas del buzón del producto que una baja o una suspensión pueden descartar, bloqueadas por id ANTES de
 * verificar el evento y del primer efecto. Las IN_PROGRESS no se tocan: nadie aquí las modifica.
 */
export async function bloquearBuzon(
  tx: Prisma.TransactionClient,
  f: { productId: string; locationLinkId: string; generation: number },
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM "ShopifyStockOutbox"
     WHERE "productId" = ${f.productId} AND "locationLinkId" = ${f.locationLinkId} AND generation = ${f.generation}
       AND status IN ('PENDING', 'FAILED', 'DEAD_LETTER')
     ORDER BY id FOR UPDATE`
}

/** Una variante, en UNA transacción: queda pareja o queda su motivo en «Productos sin pareja». Nada se descarta. */
export async function upsertShopifyVariant(ctx: ContextoCatalogo, v: VarianteShopify): Promise<UpsertOutcome> {
  const efectos: Efectos = {}
  let r: UpsertOutcome
  try {
    r = await prisma.$transaction(async (tx): Promise<UpsertOutcome> => {
      // Lo que esta transacción escriba en Inventory (la fila en 0 de un alta) no es un movimiento de Avoqado.
      await marcarOrigenShopify(tx)
      // N08: el catálogo maestro es precondición de TODO upsert (emparejar y editar también escriben catálogo). Toma la
      // cerca de la sucursal, primera en el orden de candados.
      await assertLegacyCatalogGovernanceForVenue(tx, {
        venueId: ctx.venueId,
        operation: 'CREATE',
        willBeVendable: true,
        actor: SHOPIFY_SERVICE_ACTOR,
      })
      const nivel = nivelDeVariante(v)
      const importado: Importado = ctx.importando
        ? { importedAvailable: nivel.kind === 'OK' ? nivel.available : null, importedAt: new Date() }
        : {}
      const sku = normalizeSku(v.sku)
      const gtin = gtinDe(v)
      // Lecturas SIN candado sólo para saber qué Product bloquear; todo se vuelve a leer bloqueado.
      const parejaVista = await tx.shopifyVariantLink.findUnique({
        where: { locationLinkId_shopifyVariantId: { locationLinkId: ctx.locationLinkId, shopifyVariantId: v.id } },
        select: { id: true, productId: true },
      })
      const skuVisto =
        !parejaVista && sku
          ? await tx.product.findUnique({ where: { venueId_sku: { venueId: ctx.venueId, sku } }, select: { id: true } })
          : null
      const codigoVisto =
        !parejaVista && gtin
          ? await tx.product.findUnique({ where: { venueId_gtin: { venueId: ctx.venueId, gtin } }, select: { id: true } })
          : null
      const productos = await bloquearProductos(tx, [parejaVista?.productId, skuVisto?.id, codigoVisto?.id])
      const { sweepId } = await cercar(tx, ctx)

      if (parejaVista) {
        // BR-6: toda mutación de la pareja, después de `bloquearPareja` (sucursal → tienda → pareja).
        const pareja = await bloquearPareja(tx, parejaVista.id)
        const producto = pareja ? productos.get(pareja.productId) : undefined
        if (!pareja || pareja.shopifyVariantId !== v.id || pareja.locationLinkId !== ctx.locationLinkId || !producto) {
          throw new Error('la pareja cambió mientras se leía; se reintenta')
        }
        const vigente = await tx.shopifyVariantLink.findUniqueOrThrow({ where: { id: pareja.id }, select: { inventoryItemId: true } })
        const cambioArticulo = vigente.inventoryItemId !== v.inventoryItem.id
        // Suspender descarta las filas que nunca salieron (§12.5): pareja → Inventory → filas (§10.3), antes del evento.
        if (cambioArticulo) {
          await bloquearInventario(tx, pareja.productId)
          await bloquearBuzon(tx, { productId: pareja.productId, locationLinkId: pareja.locationLinkId, generation: pareja.generation })
        }
        await verificarReclamo(tx, ctx.reclamo) // el evento, último candado
        return actualizarPareja(tx, ctx, v, pareja, producto, importado, sweepId, cambioArticulo, efectos)
      }
      // Sin pareja no hay más candados del estado (el alta de Inventory es INSERT ... ON CONFLICT DO NOTHING).
      await verificarReclamo(tx, ctx.reclamo)
      if (!sku) {
        await anotar(tx, ctx.venueId, v, 'SIN_SKU')
        return { kind: 'PROBLEMA', reason: 'SIN_SKU' }
      }
      // Con los Product bloqueados, la identidad se vuelve a leer: si otro la tomó mientras tanto, se reintenta.
      const porSku = await tx.product.findUnique({ where: { venueId_sku: { venueId: ctx.venueId, sku } }, select: { id: true } })
      const porCodigo = gtin
        ? await tx.product.findUnique({ where: { venueId_gtin: { venueId: ctx.venueId, gtin } }, select: { id: true } })
        : null
      if ((porSku?.id ?? null) !== (skuVisto?.id ?? null) || (porCodigo?.id ?? null) !== (codigoVisto?.id ?? null)) {
        throw new Error('el SKU o el código cambió de producto mientras se leía; se reintenta')
      }
      if (porSku && porCodigo && porSku.id !== porCodigo.id) {
        await anotar(tx, ctx.venueId, v, 'IDENTIDAD_EN_CONFLICTO', 'El SKU es de un producto y el código de barras de otro')
        return { kind: 'PROBLEMA', reason: 'IDENTIDAD_EN_CONFLICTO' }
      }
      const candidato = productos.get(porSku?.id ?? porCodigo?.id ?? '')
      if (!candidato) return crearProducto(tx, ctx, v, sku, gtin, importado, sweepId)
      const motivo = motivoParaNoLigar(candidato, v, porSku !== null)
      if (motivo && motivo !== 'RESTAURAR') {
        await anotar(tx, ctx.venueId, v, motivo, null, candidato.id)
        return { kind: 'PROBLEMA', reason: motivo }
      }
      // Restaurar = el MISMO producto con su historia (decisión del 29-sep): ya existía, así que se compara (§9.6).
      if (motivo === 'RESTAURAR') await restaurar(tx, ctx.venueId, candidato.id, efectos)
      return ligar(tx, ctx, v, candidato, importado, false, sweepId)
    })
  } catch (e) {
    if (e instanceof ContextoObsoleto) return { kind: 'OBSOLETO' }
    throw e
  }
  if (efectos.restaurado) {
    logAction({
      venueId: ctx.venueId,
      action: 'SHOPIFY_PRODUCT_RESTORED',
      entity: 'Product',
      entityId: efectos.restaurado,
      data: { variante: v.id },
    })
  }
  return r
}

async function ligar(
  tx: Prisma.TransactionClient,
  ctx: ContextoCatalogo,
  v: VarianteShopify,
  producto: { id: string; venueId: string; trackInventory: boolean; inventoryMethod: 'QUANTITY' | 'RECIPE' | null },
  importado: Importado,
  creada: boolean,
  sweepId: number,
): Promise<UpsertOutcome> {
  await ensureQuantityInventoryRow(tx, producto)
  const pareja = await tx.shopifyVariantLink.create({
    data: {
      locationLinkId: ctx.locationLinkId,
      venueId: ctx.venueId,
      productId: producto.id,
      shopifyProductId: v.product.id,
      shopifyVariantId: v.id,
      inventoryItemId: v.inventoryItem.id,
      originalSku: v.sku,
      createdProduct: creada,
      lastSeenSweepId: sweepId,
      // Nace sin espejo: «nunca leído». Con el `now()` por omisión, una lectura hecha ANTES de crearla (la del sync, B-1)
      // se vería vieja y `initializePair` nunca la iniciaría (REINTENTAR para siempre).
      mirrorAt: new Date(0),
      ...importado,
    },
    select: { id: true },
  })
  await tx.shopifyImportIssue.deleteMany({ where: { venueId: ctx.venueId, shopifyVariantId: v.id, reason: { not: 'SIN_PRECIO' } } })
  return {
    kind: creada ? 'CREADO' : 'LIGADO',
    variantLinkId: pareja.id,
    productId: producto.id,
    iniciada: false,
    creadaPorConector: creada,
  }
}

async function crearProducto(
  tx: Prisma.TransactionClient,
  ctx: ContextoCatalogo,
  v: VarianteShopify,
  sku: string,
  gtin: string | null,
  importado: Importado,
  sweepId: number,
): Promise<UpsertOutcome> {
  const precio = precioMxn(v)
  await assertLegacyCatalogGovernanceForVenue(tx, {
    venueId: ctx.venueId,
    operation: 'CREATE',
    willBeVendable: precio !== null,
    actor: SHOPIFY_SERVICE_ACTOR,
  })
  const categoryId = await categoriaPara(tx, ctx.venueId, v.product.productType)
  const creado = await tx.product.create({
    data: {
      venueId: ctx.venueId,
      createdById: null,
      sku,
      gtin,
      name: nombreDe(v),
      price: precio ?? new Prisma.Decimal(0),
      categoryId,
      imageUrl: imagenDe(v),
      type: 'REGULAR',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
      active: precio !== null,
      originSystem: 'SHOPIFY',
    },
    select: { id: true, venueId: true, trackInventory: true, inventoryMethod: true },
  })
  await writeLegacyServiceProductCreationAuditForVenue(tx, { venueId: ctx.venueId, productId: creado.id, actor: SHOPIFY_SERVICE_ACTOR })
  const r = await ligar(tx, ctx, v, creado, importado, true, sweepId)
  if (precio === null) await anotar(tx, ctx.venueId, v, 'SIN_PRECIO', 'Ponle precio en Avoqado para venderlo en la tienda', creado.id)
  return r
}

/** Saca del archivo un producto que archivó el conector (el producto ya está bloqueado y es elegible). */
async function restaurar(tx: Prisma.TransactionClient, venueId: string, productId: string, efectos: Efectos): Promise<void> {
  const actual = await tx.product.findUniqueOrThrow({ where: { id: productId }, select: { price: true } })
  const vendible = actual.price.gt(0)
  await assertLegacyCatalogGovernanceForVenue(tx, {
    venueId,
    operation: 'ACTIVATE',
    willBeVendable: vendible,
    actor: SHOPIFY_SERVICE_ACTOR,
  })
  await tx.product.update({ where: { id: productId }, data: { deletedAt: null, deletedBy: null, active: vendible } })
  efectos.restaurado = productId
}

/**
 * Ediciones de una pareja que ya existe (#20): nombre, SKU, código, SKU original e imagen; lo ocupado se conserva y se
 * avisa. Si el conector archivó su producto (pareja suspendida con un envío en camino, §10.4) y la variante volvió, se
 * restaura si sigue siendo elegible; el sync o el cuadre la reactivan comparando. Si la variante cambió de artículo de
 * inventario (BR-6, K14), la pareja se suspende (`NIVEL_INEXISTENTE`: conserva la barrera de lo que esté en camino) y
 * guarda el id nuevo; el cuadre la vuelve a comparar. `iniciada` = viva: iniciada y no suspendida.
 */
async function actualizarPareja(
  tx: Prisma.TransactionClient,
  ctx: ContextoCatalogo,
  v: VarianteShopify,
  pareja: { id: string; productId: string; initializedAt: Date | null; createdProduct: boolean; suspendedReason: string | null },
  producto: Candidato,
  importado: Importado,
  sweepId: number,
  cambioArticulo: boolean,
  efectos: Efectos,
): Promise<UpsertOutcome> {
  // Archivado por el conector y ya no elegible (pasó a receta, a kilo…): se queda archivado y nadie lo compara.
  const noElegible = archivadoPorShopify(producto) ? inelegible(producto) : null
  if (noElegible) await anotar(tx, ctx.venueId, v, noElegible, null, producto.id)
  else if (archivadoPorShopify(producto)) await restaurar(tx, ctx.venueId, producto.id, efectos)
  if (cambioArticulo) await suspendPair(tx, pareja.id, 'NIVEL_INEXISTENTE')
  const actual = await tx.product.findUniqueOrThrow({ where: { id: pareja.productId }, select: { id: true, sku: true, gtin: true } })
  const avisos: Array<{ reason: ShopifyIssueReason; detail: string }> = []
  let sku = actual.sku
  const skuNuevo = normalizeSku(v.sku)
  if (skuNuevo && skuNuevo !== actual.sku) {
    const ocupado = await tx.product.findUnique({ where: { venueId_sku: { venueId: ctx.venueId, sku: skuNuevo } }, select: { id: true } })
    if (ocupado)
      avisos.push({ reason: 'SKU_CHOCA', detail: `El SKU nuevo (${skuNuevo}) ya es de otro producto; se conservó ${actual.sku}` })
    else sku = skuNuevo
  }
  let gtin = actual.gtin
  const gtinNuevo = gtinDe(v)
  if (gtinNuevo !== actual.gtin) {
    const ocupado = gtinNuevo
      ? await tx.product.findUnique({ where: { venueId_gtin: { venueId: ctx.venueId, gtin: gtinNuevo } }, select: { id: true } })
      : null
    if (ocupado)
      avisos.push({ reason: 'CODIGO_REPETIDO', detail: `El código ${gtinNuevo} ya es de otro producto; se conservó el anterior` })
    else gtin = gtinNuevo
  }
  await tx.product.update({ where: { id: actual.id }, data: { name: nombreDe(v), sku, gtin, imageUrl: imagenDe(v) } })
  await tx.shopifyVariantLink.update({
    where: { id: pareja.id },
    data: {
      originalSku: v.sku,
      shopifyProductId: v.product.id,
      inventoryItemId: v.inventoryItem.id,
      lastSeenSweepId: sweepId,
      ...importado,
    },
  })
  if (avisos.length > 0) {
    await anotar(tx, ctx.venueId, v, avisos[0].reason, avisos.map(a => a.detail).join('. '), actual.id)
  } else {
    await tx.shopifyImportIssue.deleteMany({
      where: { venueId: ctx.venueId, shopifyVariantId: v.id, reason: { in: ['SKU_CHOCA', 'CODIGO_REPETIDO'] } },
    })
  }
  return {
    kind: 'ACTUALIZADO',
    variantLinkId: pareja.id,
    productId: actual.id,
    // `true` también si no es elegible: así el sync no compara (ni reactiva) un producto que no debe sincronizarse.
    iniciada: noElegible !== null || (pareja.initializedAt !== null && pareja.suspendedReason === null && !cambioArticulo),
    creadaPorConector: pareja.createdProduct,
  }
}

/** El candado del catálogo maestro rechazó la escritura (ENFORCED): el conector no se soporta ahí. */
export const esErrorDeGobierno = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === 'CATALOG_GOVERNANCE_REQUIRED'

export type DepsCatalogo = {
  graphql?: typeof shopifyGraphql
  upsert?: typeof upsertShopifyVariant
  /** Se pasa tal cual a `initializePair` (§9.7); sin él, A usa `venueHasFeatureAccess`. */
  hasAccess?: (venueId: string) => Promise<boolean>
  /** Lease de la sucursal (§10.1): cada escritura de progreso hace CAS con él. */
  workToken?: string | null
  /** Vencimiento absoluto de la unidad del worker (ms epoch, §11.6); sin él, el tope de A por petición. */
  vence?: number
  /** Reclamo del evento (§10.7) y su renovación entre páginas: `false` = otro proceso lo tomó. */
  reclamo?: Reclamo | null
  renovar?: () => Promise<boolean>
  /** §12.8: el avance ya guardado de este sync y cómo guardarlo (B2 lo pone en el evento); `false` = el reclamo es de otro. */
  avance?: AvanceSync
  guardarAvance?: (avance: AvanceSync) => Promise<boolean>
}

/**
 * Una página de la carga inicial (sucursal CONNECTING). El cursor avanza SÓLO si cada variante de la página dejó
 * resultado persistido (#19) y la sucursal sigue siendo la que pidió la página (N05, §10.1). Un error transitorio no
 * avanza y suma `importAttempts`; al 5º sobre el mismo cursor, la variante culpable queda ERROR_IMPORTACION y la página
 * sigue. La última página deja la sucursal en REVIEWING. La primera también cuenta el catálogo: con más de 20,000
 * variantes queda `CATALOGO_MUY_GRANDE`. `FALTA_PERMISO` y `CATALOGO_MAESTRO` también son terminales (§12.2): toda escritura
 * de la página exige con su CAS que la sucursal NO tenga uno, así que una página que viajaba mientras otra operación
 * marcaba uno ni avanza ni lo borra; sólo renovar la credencial lo limpia (§11.4).
 */
export async function importCatalogPage(
  locationLinkId: string,
  deps: DepsCatalogo = {},
): Promise<{ done: boolean; procesadas: number } | { error: string; retry: boolean }> {
  const upsert = deps.upsert ?? upsertShopifyVariant
  const link = await prisma.shopifyLocationLink.findUnique({ where: { id: locationLinkId }, include: { store: true } })
  if (!link || link.status !== 'CONNECTING') return { error: 'NO_ESTA_IMPORTANDO', retry: false }
  if (link.store.status !== 'ACTIVE') return { error: 'TIENDA_REVOCADA', retry: false }
  if (link.importError && SHOPIFY_IMPORT_ERRORES_TERMINALES.includes(link.importError)) return { error: link.importError, retry: false }
  const workToken = deps.workToken ?? null
  if (workToken && link.workToken !== workToken) return { error: 'SIN_LEASE', retry: false }
  const ctx = contextoDe(link, link.store, 'CONNECTING', true, { workToken, hasAccess: deps.hasAccess })
  const cursor = link.importCursor
  // CAS de todo progreso: la MISMA sucursal (generación, tienda, credencial, lease), el MISMO cursor, la tienda ACTIVE y
  // ningún error terminal (§12.2): ni un error pasajero ni el avance pisan un FALTA_PERMISO que alguien marcó mientras
  // tanto.
  const mismo: Prisma.ShopifyLocationLinkWhereInput = {
    id: link.id,
    status: 'CONNECTING',
    generation: link.generation,
    storeId: link.storeId,
    importCursor: cursor,
    workToken: workToken ?? undefined,
    OR: [{ importError: null }, { importError: { notIn: SHOPIFY_IMPORT_ERRORES_TERMINALES } }],
    store: { is: { status: 'ACTIVE', tokenVersion: link.store.tokenVersion } },
  }
  // B-7: un token que no se puede descifrar no tumba la unidad; queda a la vista (pasajero) y no salió nada.
  const token = leerToken(link.store)
  if (token === null) {
    await prisma.shopifyLocationLink.updateMany({ where: mismo, data: { importError: TOKEN_ILEGIBLE } })
    return { error: TOKEN_ILEGIBLE, retry: true }
  }
  const graphql = conVencimiento(deps.graphql ?? shopifyGraphql, deps.vence)
  const r = await graphql<PaginaVariantes>(
    link.store.shopDomain,
    token,
    QUERY_VARIANTES,
    {
      first: CATALOG_PAGE_SIZE,
      after: cursor,
      query: FILTRO_ESTADO,
      loc: link.shopifyLocationId,
      conteo: cursor === null,
      limite: SHOPIFY_MAX_VARIANTS + 1,
    },
    { validate: paginaValida({ cursor, conteo: cursor === null }) },
  )
  if (r === SIN_TIEMPO) return { error: 'SIN_TIEMPO', retry: true } // no salió nada: no cuenta como intento
  if (!r.ok) {
    const atencion = await atenderFalla(link.store, r, [{ id: link.id, generation: link.generation }])
    if (atencion === 'SIN_PERMISO') return { error: FALTA_PERMISO, retry: false }
    await prisma.shopifyLocationLink.updateMany({
      where: mismo,
      data: { importError: `${r.code}: ${r.message}`.slice(0, 500), importAttempts: { increment: r.code === 'THROTTLED' ? 0 : 1 } },
    })
    return { error: r.code, retry: atencion === 'REINTENTAR' }
  }
  if (cursor === null && (r.data.total?.count ?? 0) > SHOPIFY_MAX_VARIANTS) {
    await prisma.shopifyLocationLink.updateMany({ where: mismo, data: { importError: CATALOGO_MUY_GRANDE } })
    logger.warn(`[SHOPIFY] importación ${link.id}: más de ${SHOPIFY_MAX_VARIANTS} variantes; no se conecta en esta versión`)
    return { error: CATALOGO_MUY_GRANDE, retry: false }
  }
  const { nodes, pageInfo } = r.data.productVariants
  // C10: la tienda tiene variantes (el conteo va SIN filtro) y el filtro de estado no trae ninguna. Puede ser legítimo
  // (todo archivado) y por eso no detiene la conexión, pero así fue como un filtro en mayúsculas conectaba tiendas vacías
  // sin que nadie se enterara: queda en el log, con los dos números.
  const totalTienda = r.data.total?.count ?? 0
  if (cursor === null && nodes.length === 0 && !pageInfo.hasNextPage && totalTienda > 0) {
    logger.warn(
      `[SHOPIFY] importación ${link.id}: 0 variantes activas o en borrador de ${totalTienda} en la tienda; revisa el filtro de estado`,
    )
  }
  // Las que ya quedaron ERROR_IMPORTACION en un intento anterior de esta misma página no se reintentan aquí.
  const fallidas = new Set(
    (
      await prisma.shopifyImportIssue.findMany({
        where: { venueId: link.venueId, reason: 'ERROR_IMPORTACION', shopifyVariantId: { in: nodes.map(n => n.id) } },
        select: { shopifyVariantId: true },
        take: CATALOG_PAGE_SIZE,
      })
    ).map(i => i.shopifyVariantId),
  )
  let intentos = link.importAttempts
  for (const v of nodes) {
    if (fallidas.has(v.id)) continue
    try {
      const u = await upsert(ctx, v)
      if (u.kind === 'OBSOLETO') return { error: 'CONTEXTO_CAMBIO', retry: false }
    } catch (err) {
      if (esErrorDeGobierno(err)) {
        await prisma.shopifyLocationLink.updateMany({ where: mismo, data: { importError: CATALOGO_MAESTRO } })
        return { error: CATALOGO_MAESTRO, retry: false }
      }
      const mensaje = `Variante ${v.id}: ${(err as Error)?.message ?? String(err)}`.slice(0, 500)
      intentos += 1
      if (intentos < MAX_INTENTOS_IMPORTACION) {
        await prisma.shopifyLocationLink.updateMany({ where: mismo, data: { importAttempts: intentos, importError: mensaje } })
        return { error: 'VARIANTE_FALLO', retry: true }
      }
      // 5º intento sobre el mismo cursor: la variante queda a la vista y la importación sigue. También cercada (N05).
      const anotada = await anotarFallida(ctx, v, mensaje)
      if (!anotada) return { error: 'CONTEXTO_CAMBIO', retry: false }
      logger.error(`[SHOPIFY] importación ${link.id}: ${mensaje} (se sigue sin ella)`)
      intentos = 0
    }
  }
  const fin = !pageInfo.hasNextPage
  // `importError: null` sólo puede borrar un error PASAJERO (el «HTTP_5XX» de un intento anterior): el CAS no deja pasar
  // a una sucursal con uno terminal (§12.2).
  const avance = await prisma.shopifyLocationLink.updateMany({
    where: mismo,
    data: fin
      ? { importCursor: null, importAttempts: 0, importError: null, status: 'REVIEWING', importedAt: new Date() }
      : { importCursor: pageInfo.endCursor, importAttempts: 0, importError: null },
  })
  if (avance.count === 0) return { error: 'CONTEXTO_CAMBIO', retry: false }
  if (fin) logAction({ venueId: link.venueId, action: 'SHOPIFY_CATALOG_IMPORTED', entity: 'ShopifyLocationLink', entityId: link.id })
  return { done: fin, procesadas: nodes.length }
}

/** La variante que falló cinco veces queda en «Productos sin pareja», en una tx con el mismo cerco que el upsert (N05). */
async function anotarFallida(ctx: ContextoCatalogo, v: VarianteShopify, mensaje: string): Promise<boolean> {
  try {
    await prisma.$transaction(async tx => {
      await cercar(tx, ctx)
      await tx.shopifyImportIssue.upsert({
        where: { venueId_shopifyVariantId: { venueId: ctx.venueId, shopifyVariantId: v.id } },
        create: {
          venueId: ctx.venueId,
          shopifyVariantId: v.id,
          shopifyProductId: v.product.id,
          title: nombreDe(v),
          sku: v.sku,
          reason: 'ERROR_IMPORTACION',
          detail: mensaje,
        },
        update: { reason: 'ERROR_IMPORTACION', detail: mensaje, title: nombreDe(v), sku: v.sku },
      })
    })
    return true
  } catch (e) {
    if (e instanceof ContextoObsoleto) return false
    throw e
  }
}

/**
 * products/create|update: lee TODAS las páginas de variantes del producto antes de decidir qué se archiva (#7); si una
 * falla, no archiva nada. Sólo sucursales ACTIVE y sin error terminal: en PAUSED, CONNECTING o REVIEWING el aviso espera
 * diferido (B2). §12.8 (N17): cada página se escribe en cuanto llega y el avance de cada sucursal (cursor de la página
 * que falta y variantes ya vistas) se guarda con `deps.guardarAvance` (en el evento, B2): si se acaba el tiempo, la
 * siguiente vez sigue en la página que faltaba en vez de repetir la primera. Antes de CADA variante y de CADA baja se
 * mira el vencimiento; las peticiones salen con lo que queda (§11.6). Después de cada página, cada 10 variantes y después
 * de cada tanda de bajas se renueva el reclamo del evento; cada escritura lo verifica dentro de su transacción.
 */
export async function syncShopifyProduct(
  storeId: string,
  productGid: string,
  deps: DepsCatalogo = {},
): Promise<{ ok: true } | { error: string; retry: boolean }> {
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId } })
  if (!store || store.status !== 'ACTIVE') return { error: 'TIENDA_REVOCADA', retry: false }
  const avance: AvanceSync = { ...(deps.avance ?? {}) }
  let despues = ''
  for (;;) {
    const links = await prisma.shopifyLocationLink.findMany({
      where: { ...sucursalTrabajable(storeId), id: { gt: despues } },
      select: { id: true, venueId: true, generation: true, storeId: true, shopifyLocationId: true },
      orderBy: { id: 'asc' },
      take: 20,
    })
    for (const link of links) {
      const r = await sincronizarEnSucursal(store, link, productGid, deps, avance)
      if ('error' in r) return r
    }
    if (links.length < 20) return { ok: true }
    despues = links[links.length - 1].id
  }
}

/** §12.8: el avance de un sync por `sucursal:generación`: el cursor de la página que falta (o `FIN_PAGINAS`) y lo ya visto. */
export type AvanceSync = Record<string, { cursor: string | null; vistas: string[] } | null>
/** Ya se leyeron todas las páginas: lo que falta son las bajas. */
export const FIN_PAGINAS = '__FIN__'

async function sincronizarEnSucursal(
  store: { id: string; shopDomain: string; accessTokenCiphertext: Uint8Array | Buffer; tokenVersion: number },
  link: { id: string; venueId: string; generation: number; storeId: string; shopifyLocationId: string },
  productGid: string,
  deps: DepsCatalogo,
  avance: AvanceSync,
): Promise<{ ok: true } | { error: string; retry: boolean }> {
  const graphql = conVencimiento(deps.graphql ?? shopifyGraphql, deps.vence)
  const upsert = deps.upsert ?? upsertShopifyVariant
  const numero = productGid.split('/').pop()
  const ctx = contextoDe(link, store, 'ACTIVE', false, { workToken: deps.workToken, reclamo: deps.reclamo, hasAccess: deps.hasAccess })
  const cerco = cercoDe(ctx)
  // OBSOLETO: el contexto cambió o el reclamo es de otro; B2 distingue cuál renovando el reclamo.
  const cambio = { error: 'CONTEXTO_CAMBIO', retry: true }
  const perdido = { error: 'RECLAMO_PERDIDO', retry: false }
  // La generación va en la llave: el avance de una conexión anterior no le sirve a la nueva.
  const clave = `${link.id}:${link.generation}`
  let cursor: string | null = avance[clave]?.cursor ?? null
  const vistas = new Set(avance[clave]?.vistas ?? [])
  const renovado = async (): Promise<boolean> => !deps.renovar || deps.renovar()
  /** Guarda el avance (y con él renueva el reclamo, B2). Sin quién lo guarde (llamada directa), vive sólo en esta llamada. */
  const guardar = async (): Promise<boolean> => {
    avance[clave] = { cursor, vistas: [...vistas] }
    return !deps.guardarAvance || deps.guardarAvance(avance)
  }
  const olvidar = async (): Promise<void> => {
    avance[clave] = null
    await deps.guardarAvance?.(avance)
  }
  const sinTiempo = async () => ((await guardar()) ? { error: 'SIN_TIEMPO', retry: true } : perdido)
  const token = leerToken(store) // B-7: ilegible ⇒ no sale nada y se reintenta, con el avance intacto
  if (token === null) return { error: TOKEN_ILEGIBLE, retry: true }
  try {
    for (let pagina = 0; cursor !== FIN_PAGINAS; pagina++) {
      if (pagina >= MAX_PAGINAS_PRODUCTO) {
        await olvidar()
        return { error: 'PRODUCTO_CON_DEMASIADAS_VARIANTES', retry: false }
      }
      const fetchedAt = new Date()
      const r = await graphql<PaginaVariantes>(
        store.shopDomain,
        token,
        QUERY_VARIANTES,
        {
          first: CATALOG_PAGE_SIZE,
          after: cursor,
          query: `product_id:${numero} ${FILTRO_ESTADO}`,
          loc: link.shopifyLocationId,
          conteo: false,
          limite: 1,
        },
        { validate: paginaValida({ cursor, conteo: false, productId: productGid }) },
      )
      if (r === SIN_TIEMPO) return sinTiempo() // no salió nada: el evento vuelve sin gastar intento
      if (!r.ok) {
        const atencion = await atenderFalla(store, r, [{ id: link.id, generation: link.generation }], eventoDe(deps.reclamo))
        await olvidar() // el siguiente intento empieza de cero (un cursor viejo puede ya no servir)
        return { error: atencion === 'SIN_PERMISO' ? FALTA_PERMISO : r.code, retry: atencion === 'REINTENTAR' }
      }
      if (!(await renovado())) return perdido
      let escritas = 0
      for (const v of r.data.productVariants.nodes) {
        if (vistas.has(v.id)) continue // ya quedó en un intento anterior
        if (restante(deps.vence) < MIN_ESCRITURA_MS) return sinTiempo()
        if (escritas > 0 && escritas % 10 === 0 && !(await renovado())) return perdido
        const u = await upsert(ctx, v) // si truena, el evento se reintenta y nada se archivó
        if (u.kind === 'OBSOLETO') return cambio
        if (u.kind !== 'PROBLEMA' && !u.iniciada) {
          const o = await initializePair(
            {
              variantLinkId: u.variantLinkId,
              nivel: nivelDeVariante(v),
              fetchedAt,
              mode: u.creadaPorConector ? 'TOMAR_SHOPIFY' : 'COMPARAR',
            },
            { hasAccess: deps.hasAccess, cerco },
          )
          if (o === 'CONTEXTO_CAMBIO') return cambio // §11.2: A no tocó nada; la unidad se detiene
          // N21: no pudo iniciarse ahora (envío en camino, lectura vieja): queda pedido el cuadre, que la reintenta.
          if (o === 'REINTENTAR' || o === 'NO_APLICA') await pedirCuadre(link.id)
        }
        vistas.add(v.id)
        escritas += 1
      }
      const pi = r.data.productVariants.pageInfo
      cursor = pi.hasNextPage ? pi.endCursor : FIN_PAGINAS
      if (!(await guardar())) return perdido
    }
  } catch (err) {
    if (esErrorDeGobierno(err)) return { error: CATALOGO_MAESTRO, retry: false }
    // `atenderFalla` (401/403) verifica el reclamo al final de su tx: si otro proceso tomó el evento, nada quedó marcado.
    if (err instanceof ContextoObsoleto) return perdido
    throw err
  }
  // Huérfanas: SÓLO con el recorrido completo, las parejas del producto cuya variante no vino en NINGUNA página. FF-I2:
  // cada una se confirma antes con una lectura directa por id; la que Shopify dice que sigue no se archiva.
  let despues = ''
  for (;;) {
    const tanda = await prisma.shopifyVariantLink.findMany({
      where: { locationLinkId: link.id, shopifyProductId: productGid, id: { gt: despues } },
      select: { id: true, productId: true, venueId: true, locationLinkId: true, shopifyVariantId: true },
      orderBy: { id: 'asc' },
      take: TANDA,
    })
    const huerfanas = tanda.filter(p => !vistas.has(p.shopifyVariantId))
    if (huerfanas.length > 0) {
      const c = await confirmarBajas(
        store.shopDomain,
        token,
        huerfanas.map(p => p.shopifyVariantId),
        graphql,
      )
      if (c === SIN_TIEMPO) return sinTiempo() // el cursor ya dice FIN: la próxima vez sólo bajas
      if (!c.ok) {
        try {
          const atencion = await atenderFalla(store, c, [{ id: link.id, generation: link.generation }], eventoDe(deps.reclamo))
          return { error: atencion === 'SIN_PERMISO' ? FALTA_PERMISO : c.code, retry: atencion === 'REINTENTAR' }
        } catch (err) {
          if (err instanceof ContextoObsoleto) return perdido
          throw err
        }
      }
      for (const p of huerfanas) {
        if (!c.data.has(p.shopifyVariantId)) {
          logger.warn(
            `[SHOPIFY] sync ${link.id}: la variante ${p.shopifyVariantId} no vino en la búsqueda pero sigue en Shopify; no se archiva`,
          )
          continue
        }
        if (restante(deps.vence) < MIN_ESCRITURA_MS) return sinTiempo()
        if ((await archivarPareja(p, cerco)) === 'OBSOLETO') return cambio
      }
    }
    if (!(await renovado())) return perdido
    if (tanda.length < TANDA) return { ok: true }
    despues = tanda[tanda.length - 1].id
  }
}

/** Por qué un archivo se detuvo antes de terminar (§12.8, N11): el evento NO se da por procesado. */
export type ArchivoInterrumpido = 'CONTEXTO_CAMBIO' | 'RECLAMO_PERDIDO' | 'SIN_TIEMPO'

/**
 * products/delete: archiva (nunca borra el producto) cada pareja del producto en la tienda, por tandas. Cada pareja va
 * con el cerco de SU sucursal tal como se leyó junto con ella y la credencial con que se procesa el evento (N05): si la
 * sucursal se reconectó entre la lectura y la tx, esa pareja no se toca. Si algo lo detiene (el contexto, el reclamo
 * perdido entre tandas o el vencimiento antes de una pareja), lo DICE en `interrumpido` (§12.8, N11): lo archivado ya no
 * vuelve a salir y la siguiente pasada sigue con lo que falta.
 */
export async function archiveShopifyProduct(
  storeId: string,
  productGid: string,
  deps: { reclamo?: Reclamo | null; renovar?: () => Promise<boolean>; vence?: number } = {},
): Promise<{ archivadas: number; suspendidas: number; interrumpido?: ArchivoInterrumpido }> {
  let archivadas = 0
  let suspendidas = 0
  const store = await prisma.shopifyStore.findUnique({ where: { id: storeId }, select: { status: true, tokenVersion: true } })
  if (!store || store.status !== 'ACTIVE') return { archivadas, suspendidas, interrumpido: 'CONTEXTO_CAMBIO' }
  let despues = ''
  for (;;) {
    // Sólo sucursales ACTIVE y sin error terminal: una detenida (FALTA_PERMISO, CATALOGO_MAESTRO…) no pasaría el cerco y
    // detendría el archivo de las sanas en cada pasada; una desconectada o en pausa no se toca.
    const tanda = await prisma.shopifyVariantLink.findMany({
      where: { shopifyProductId: productGid, locationLink: sucursalTrabajable(storeId), id: { gt: despues } },
      select: {
        id: true,
        productId: true,
        venueId: true,
        locationLinkId: true,
        shopifyVariantId: true,
        locationLink: { select: { generation: true, shopifyLocationId: true } },
      },
      orderBy: { id: 'asc' },
      take: TANDA,
    })
    for (const p of tanda) {
      if (restante(deps.vence) < MIN_ESCRITURA_MS) return { archivadas, suspendidas, interrumpido: 'SIN_TIEMPO' }
      const r = await archivarPareja(p, {
        generation: p.locationLink.generation,
        storeId,
        shopifyLocationId: p.locationLink.shopifyLocationId,
        tokenVersion: store.tokenVersion,
        evento: eventoDe(deps.reclamo),
      })
      if (r === 'OBSOLETO') return { archivadas, suspendidas, interrumpido: 'CONTEXTO_CAMBIO' }
      if (r === 'ARCHIVADA') archivadas += 1
      if (r === 'SUSPENDIDA') suspendidas += 1
    }
    if (tanda.length < TANDA) return { archivadas, suspendidas }
    if (deps.renovar && !(await deps.renovar())) return { archivadas, suspendidas, interrumpido: 'RECLAMO_PERDIDO' }
    despues = tanda[tanda.length - 1].id
  }
}

export type ParejaParaArchivar = { id: string; productId: string; venueId: string; locationLinkId: string; shopifyVariantId: string }

/**
 * Archiva el producto de una pareja que desapareció de Shopify (§10.4). Orden §10.3 y §12.5: Product (`FOR NO KEY
 * UPDATE`, K11) → sucursal → tienda → pareja (`bloquearPareja` de A, BR-6) → las filas del buzón y la revisión que se van
 * a modificar → evento, y sólo después el primer efecto. Con `cerco` (lo que vio quien decidió la baja, N05), la sucursal
 * debe seguir en esa generación, con esa tienda, ubicación, credencial y lease, la tienda ACTIVE y sin error terminal
 * (§12.2): si no, `OBSOLETO` y nada cambia. Lo que nunca salió se descarta; si queda un envío en camino, la pareja se
 * SUSPENDE y conserva la barrera (el cuadre la vuelve a intentar); si no, se borra, se descartan las atoradas y se cierran
 * sus revisiones.
 */
export async function archivarPareja(
  p: ParejaParaArchivar,
  cerco: CercoShopify | null = null,
): Promise<'ARCHIVADA' | 'SUSPENDIDA' | 'NADA' | 'OBSOLETO'> {
  try {
    const r = await prisma.$transaction(async tx => {
      const [prod] = await tx.$queryRaw<
        Array<{ deletedAt: Date | null }>
      >`SELECT "deletedAt" FROM "Product" WHERE id = ${p.productId} FOR NO KEY UPDATE`
      if (cerco) await exigirCerco(tx, p.locationLinkId, cerco) // sucursal → tienda, con lo que vio quien decidió la baja
      const pareja = await bloquearPareja(tx, p.id)
      if (!prod || !pareja || pareja.productId !== p.productId || pareja.locationLinkId !== p.locationLinkId)
        return { estado: 'NADA' as const }
      const filas = { productId: p.productId, locationLinkId: p.locationLinkId, generation: pareja.generation }
      await bloquearInventario(tx, p.productId) // §10.3: pareja → Inventory → filas
      // §12.5: las filas que este archivo puede tocar, bloqueadas ANTES de verificar el evento y del primer efecto.
      await bloquearBuzon(tx, filas)
      await tx.$queryRaw`SELECT id FROM "ShopifyReviewItem" WHERE "productId" = ${p.productId} AND status = 'OPEN' ORDER BY id FOR UPDATE`
      await verificarEvento(tx, cerco?.evento) // el evento, último candado
      const archivado = !prod.deletedAt
      if (archivado) await archivarProductos(tx, { venueId: p.venueId, id: p.productId }, ARCHIVADO_POR_SHOPIFY)
      if (await envioEnCamino(tx, filas)) {
        await suspendPair(tx, p.id, 'NIVEL_INEXISTENTE') // descarta sólo lo que nunca salió (A6)
        return { estado: 'SUSPENDIDA' as const, archivado }
      }
      const ahora = new Date()
      await tx.shopifyStockOutbox.updateMany({
        where: { ...filas, status: { in: ['PENDING', 'FAILED', 'DEAD_LETTER'] } },
        data: { status: 'DISCARDED', lastError: 'ARCHIVADO_EN_SHOPIFY', processedAt: ahora, claimToken: null, leaseUntil: null },
      })
      await tx.shopifyReviewItem.updateMany({
        where: { productId: p.productId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: ahora, offset: 0 },
      })
      await tx.shopifyImportIssue.deleteMany({ where: { venueId: p.venueId, shopifyVariantId: p.shopifyVariantId } })
      await tx.shopifyVariantLink.delete({ where: { id: p.id } })
      return { estado: 'ARCHIVADA' as const, archivado }
    })
    // El producto archivado (aunque la pareja quede suspendida esperando su envío) y la pareja borrada dejan rastro.
    if (r.estado === 'ARCHIVADA' || (r.estado === 'SUSPENDIDA' && r.archivado)) {
      logAction({
        venueId: p.venueId,
        action: 'SHOPIFY_PRODUCT_ARCHIVED',
        entity: 'Product',
        entityId: p.productId,
        data: { variante: p.shopifyVariantId, pareja: r.estado === 'ARCHIVADA' ? 'BORRADA' : 'SUSPENDIDA' },
      })
    }
    return r.estado
  } catch (e) {
    if (e instanceof ContextoObsoleto) return 'OBSOLETO'
    throw e
  }
}
