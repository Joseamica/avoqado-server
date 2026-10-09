// tests/integration/shopify/fixturesB.ts
/** Ayudas de las pruebas del plan B: variantes con la forma de QUERY_VARIANTES, niveles falsos y eventos en mano. */
import { randomUUID } from 'crypto'
import { Prisma, type ShopifyLinkStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  contextoDe,
  type ContextoCatalogo,
  type Reclamo,
  type VarianteShopify,
} from '@/services/commerce-channels/shopify/shopify.catalog.service'
import type { ShopifyFailure, ShopifyFailureCode, ShopifyResult } from '@/services/commerce-channels/shopify/shopify.graphql'
import { levelKey, type fetchLevels, type NivelLeido } from '@/services/commerce-channels/shopify/shopify.mirror.service'
import { limpiarEscenarioShopify, type EscenarioShopify } from './fixtures'

export type OpcionesVariante = {
  sku?: string | null
  barcode?: string | null
  titulo?: string
  opcion?: string
  producto?: string
  tipo?: string
  status?: string
  precio?: { amount: string; currencyCode: string } | null
  imagenVariante?: string | null
  imagenProducto?: string | null
  available?: number
  committed?: number
  tracked?: boolean
  sinNivel?: boolean
  inactivo?: boolean
}

/** Variante `n` de Shopify. Ids `…/ProductVariant/9<n>` e `…/InventoryItem/8<n>`: nunca chocan con los del escenario. */
export function variante(n: number, o: OpcionesVariante = {}): VarianteShopify {
  return {
    id: `gid://shopify/ProductVariant/9${n}`,
    sku: o.sku === undefined ? `CAM-AZ-${n}` : o.sku,
    selectedOptions: [{ name: 'Talla', value: o.opcion ?? `M${n}` }],
    barcodes: { nodes: o.barcode === null ? [] : [{ value: o.barcode ?? `75000000${String(n).padStart(5, '0')}` }] },
    contextualPricing: { price: o.precio === undefined ? { amount: '499.00', currencyCode: 'MXN' } : o.precio },
    media: { nodes: o.imagenVariante === null ? [] : [{ preview: { image: { url: o.imagenVariante ?? `https://cdn.test/v${n}.jpg` } } }] },
    product: {
      id: o.producto ?? 'gid://shopify/Product/77',
      title: o.titulo ?? 'Camisa lino',
      productType: o.tipo ?? 'Camisas',
      status: o.status ?? 'ACTIVE',
      featuredMedia: o.imagenProducto === null ? null : { preview: { image: { url: o.imagenProducto ?? 'https://cdn.test/p.jpg' } } },
    },
    inventoryItem: {
      id: `gid://shopify/InventoryItem/8${n}`,
      tracked: o.tracked ?? true,
      inventoryLevel: o.sinNivel
        ? null
        : {
            isActive: !o.inactivo,
            quantities: [
              { name: 'available', quantity: o.available ?? 6 },
              { name: 'committed', quantity: o.committed ?? 1 },
            ],
          },
    },
  }
}

/** Una página de `productVariants`; `total` es lo que contaría `productVariantsCount` (sólo lo mira la primera página). */
export const paginaDeVariantes = (nodes: VarianteShopify[], endCursor: string | null, total = nodes.length): ShopifyResult<unknown> => ({
  ok: true,
  data: { total: { count: total }, productVariants: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } },
})

/**
 * Doble de `shopifyGraphql` que, ANTES de contestar, hace algo en la base (lo que pasaría mientras la petición viaja) y
 * respeta `validate` igual que `graphqlFalso`.
 */
export function graphqlConEfecto(efecto: () => Promise<void>, responder: (vars: any) => ShopifyResult<any>): jest.Mock {
  return jest.fn(async (_shop: string, _token: string, _query: string, vars: any = {}, opts?: { validate?: (d: unknown) => boolean }) => {
    await efecto()
    const r = responder(vars)
    if (r.ok && opts?.validate && !opts.validate(r.data)) return falla('BAD_RESPONSE', true, true)
    return r
  })
}

export const falla = (code: ShopifyFailureCode, retryable = true, ambiguous = false): ShopifyFailure => ({
  ok: false,
  code,
  retryable,
  ambiguous,
  message: `prueba ${code}`,
})

export const nivel = (available: number, committed = 0): NivelLeido => ({ kind: 'OK', available, committed })

/** Doble de `fetchLevels` para `deps.fetchLevels`: TODA llave pedida sale en el mapa, como el real. */
export function nivelesFalsos(nivelDe: (inventoryItemId: string) => NivelLeido = () => nivel(10)): jest.MockedFunction<typeof fetchLevels> {
  return jest.fn(async (_store: unknown, items: Array<{ inventoryItemId: string; shopifyLocationId: string }>) => ({
    ok: true as const,
    data: new Map(items.map(i => [levelKey(i.shopifyLocationId, i.inventoryItemId), nivelDe(i.inventoryItemId)])),
  })) as unknown as jest.MockedFunction<typeof fetchLevels>
}

/** Deja un evento reclamado con un token conocido (el reclamo real se prueba en B2). */
export async function procesando(id: string, claimToken = 'tok-prueba'): Promise<string> {
  await prisma.shopifyInboundEvent.update({
    where: { id },
    data: { status: 'PROCESSING', claimToken, leaseUntil: new Date(Date.now() + 120_000) },
  })
  return claimToken
}

/** «Tiene el plan» (§9.7): las pruebas lo pasan explícito como `deps.hasAccess`; el escenario de A no trae plan. */
export const conPlan = async (): Promise<boolean> => true

/** El contexto de catálogo de la sucursal TAL COMO ESTÁ ahora en la base (lo que llevaría una página pedida hoy). */
export async function contexto(
  e: { locationLinkId: string },
  o: { importando?: boolean; workToken?: string | null; reclamo?: Reclamo | null } = {},
): Promise<ContextoCatalogo> {
  const l = await prisma.shopifyLocationLink.findUniqueOrThrow({ where: { id: e.locationLinkId }, include: { store: true } })
  const fase = l.status === 'CONNECTING' ? 'CONNECTING' : 'ACTIVE'
  return contextoDe(l, l.store, fase, o.importando ?? fase === 'CONNECTING', { workToken: o.workToken ?? null, reclamo: o.reclamo ?? null })
}

/** Espera `ms` (pruebas del vencimiento, §11.6). */
export const dormir = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Shopify con estado para recorrer conteo → envío → jalón (§11.1): `s.available` y `s.committed` de UNA variante. Los
 * niveles se leen de `s`; un ajuste del mensajero (`inventoryAdjustQuantities`) mueve `s.available` y contesta como
 * Shopify. Así cada prueba compara las cantidades finales de los DOS lados.
 */
export function tiendaFalsa(available: number, committed: number) {
  const s = { available, committed }
  const fetchLevels = nivelesFalsos(() => nivel(s.available, s.committed))
  const graphql = jest.fn(
    async (_shop: string, _token: string, query: string, vars: any = {}, opts?: { validate?: (d: unknown) => boolean }) => {
      if (!query.includes('inventoryAdjustQuantities')) return falla('HTTP_5XX', true, false)
      s.available += Number(vars.input.changes[0].delta)
      const data = {
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: { id: `gid://shopify/InventoryAdjustmentGroup/${vars.key}` },
          userErrors: [],
        },
      }
      if (opts?.validate && !opts.validate(data)) return falla('BAD_RESPONSE', true, true)
      return { ok: true as const, data }
    },
  )
  return { s, fetchLevels, graphql }
}

/**
 * Otra sucursal de la MISMA organización y la MISMA tienda (R02, R03), en `Location/2` (o la que se pida: la tienda no
 * admite dos sucursales en la misma ubicación, R08), con su propio dueño, su producto y una pareja de la MISMA variante
 * (`ProductVariant/1`, `InventoryItem/1`). Con `sinEnlace` sólo crea la sucursal y su producto (`locationLinkId` y
 * `variantLinkId` vacíos). Se limpia con `limpiarOtraSucursal` ANTES que el escenario dueño de la tienda.
 */
export async function otraSucursalDeLaTienda(
  e: EscenarioShopify,
  o: { linkStatus?: ShopifyLinkStatus; sinEnlace?: boolean; stock?: number; shopifyLocationId?: string } = {},
): Promise<EscenarioShopify> {
  const f = `shp2-${randomUUID()}`
  const stock = o.stock ?? 10
  const venue = await prisma.venue.create({
    data: { organizationId: e.organizationId, name: f, slug: f, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  const staff = await prisma.staff.create({ data: { email: `staff-${f}@example.test`, firstName: 'Otra', lastName: 'Sucursal' } })
  await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'ADMIN', active: true } })
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: f, slug: f } })
  const product = await prisma.product.create({
    data: {
      venueId: venue.id,
      categoryId: category.id,
      name: 'Camisa · M',
      sku: `SKU-${f.slice(5, 17)}`,
      price: new Prisma.Decimal(499),
      unit: 'UNIT',
      type: 'REGULAR',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    },
  })
  const inventory = await prisma.inventory.create({
    data: { productId: product.id, venueId: venue.id, currentStock: new Prisma.Decimal(stock) },
  })
  const base = { ...e, venueId: venue.id, staffId: staff.id, categoryId: category.id, productId: product.id, inventoryId: inventory.id }
  if (o.sinEnlace) return { ...base, locationLinkId: '', variantLinkId: '' }
  const link = await prisma.shopifyLocationLink.create({
    data: {
      storeId: e.storeId,
      venueId: venue.id,
      shopifyLocationId: o.shopifyLocationId ?? 'gid://shopify/Location/2',
      locationName: 'Otra tienda',
      status: o.linkStatus ?? 'ACTIVE',
      generation: 1,
    },
  })
  const variant = await prisma.shopifyVariantLink.create({
    data: {
      locationLinkId: link.id,
      venueId: venue.id,
      productId: product.id,
      shopifyProductId: 'gid://shopify/Product/1',
      shopifyVariantId: 'gid://shopify/ProductVariant/1',
      inventoryItemId: 'gid://shopify/InventoryItem/1',
      initializedAt: new Date(),
      mirrorAvailable: stock,
      mirrorAt: new Date(Date.now() - 5_000),
    },
  })
  return { ...base, locationLinkId: link.id, variantLinkId: variant.id }
}

/** Limpia SÓLO lo de la otra sucursal: la tienda, sus eventos y la organización son del escenario dueño. */
export async function limpiarOtraSucursal(s: EscenarioShopify): Promise<void> {
  await limpiarEscenarioShopify({ ...s, storeId: '', shopDomain: '__de-otra-sucursal__', organizationId: '__de-otra-sucursal__' })
}
