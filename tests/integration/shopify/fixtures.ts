/**
 * Escenario de pruebas del conector Shopify (planes A, B y C), contra Postgres real.
 * Una tienda con token cifrado de verdad, una sucursal ligada a `gid://shopify/Location/1` y un producto LOCAL (ya
 * existía: `createdProduct = false`) plano por cantidad, con su pareja. El Inventory nace ANTES del enlace: ese INSERT
 * no tiene a quién encolarse.
 */
import { randomUUID } from 'crypto'
import { Prisma, ShopifyLinkStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { createTokenCipher } from '@/lib/token-encryption'

// Llave de prueba (32 bytes en hex) sólo si el entorno no trae una: el cifrado es el real, no un mock.
if (!process.env.SHOPIFY_TOKEN_KEY) process.env.SHOPIFY_TOKEN_KEY = 'a'.repeat(64)

export const TOKEN_DE_PRUEBA = 'token-de-prueba'
export const UBICACION_PRUEBA = 'gid://shopify/Location/1'
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)

export type EscenarioShopify = {
  organizationId: string
  venueId: string
  staffId: string
  categoryId: string
  productId: string
  inventoryId: string
  storeId: string
  locationLinkId: string
  variantLinkId: string
  shopDomain: string
}

export function assertTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1'].includes(declared.hostname) || !declared.pathname.toLowerCase().includes('test')) {
    throw new Error(`Base de pruebas inesperada: ${declared.hostname}${declared.pathname}`)
  }
  if (effective.toString() !== declared.toString()) throw new Error('DATABASE_URL no apunta a la base de pruebas')
}

export async function crearEscenarioShopify(
  o: {
    stock?: number
    linkStatus?: ShopifyLinkStatus
    pausedFrom?: ShopifyLinkStatus
    initialized?: boolean
    mirrorAvailable?: number
    mirrorCommitted?: number
    generation?: number
  } = {},
): Promise<EscenarioShopify> {
  const stock = o.stock ?? 10
  const f = `shp-${randomUUID()}`
  const org = await prisma.organization.create({ data: { name: f, email: `${f}@example.test`, phone: '5500000000' } })
  const venue = await prisma.venue.create({
    data: { organizationId: org.id, name: f, slug: f, timezone: 'America/Mexico_City', currency: 'MXN' },
  })
  const staff = await prisma.staff.create({ data: { email: `staff-${f}@example.test`, firstName: 'Prueba', lastName: 'Shopify' } })
  await prisma.staffVenue.create({ data: { staffId: staff.id, venueId: venue.id, role: 'ADMIN', active: true } })
  const category = await prisma.menuCategory.create({ data: { venueId: venue.id, name: f, slug: f } })
  const product = await prisma.product.create({
    data: {
      venueId: venue.id,
      categoryId: category.id,
      name: 'Camisa · M',
      sku: `SKU-${f.slice(4, 16)}`,
      price: D(499),
      unit: 'UNIT',
      type: 'REGULAR',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    },
  })
  const inventory = await prisma.inventory.create({ data: { productId: product.id, venueId: venue.id, currentStock: D(stock) } })
  const shopDomain = `${f}.myshopify.com`
  const store = await prisma.shopifyStore.create({
    data: {
      organizationId: org.id,
      shopDomain,
      appKey: 'PILOTO',
      accessTokenCiphertext: createTokenCipher('SHOPIFY_TOKEN_KEY').encrypt(TOKEN_DE_PRUEBA),
      scopes: 'read_products,write_products,read_inventory,write_inventory,read_locations,read_orders',
    },
  })
  const link = await prisma.shopifyLocationLink.create({
    data: {
      storeId: store.id,
      venueId: venue.id,
      shopifyLocationId: UBICACION_PRUEBA,
      locationName: 'Tienda México',
      status: o.linkStatus ?? 'ACTIVE',
      pausedFrom: o.pausedFrom ?? null,
      generation: o.generation ?? 1,
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
      initializedAt: (o.initialized ?? true) ? new Date() : null,
      mirrorAvailable: o.mirrorAvailable ?? stock,
      mirrorCommitted: o.mirrorCommitted ?? 0,
      // Explícito y en el pasado: «espejo movido después de leer Shopify» lo decide cada prueba, no el reloj.
      mirrorAt: new Date(Date.now() - 5_000),
    },
  })
  return {
    organizationId: org.id,
    venueId: venue.id,
    staffId: staff.id,
    categoryId: category.id,
    productId: product.id,
    inventoryId: inventory.id,
    storeId: store.id,
    locationLinkId: link.id,
    variantLinkId: variant.id,
    shopDomain,
  }
}

let consecutivo = 100

/** Otro producto de la misma sucursal; con `pareja` (default true) lleva su pareja con gids propios. */
export async function agregarProductoShopify(
  e: EscenarioShopify,
  o: { stock?: number; sku?: string; pareja?: boolean; initialized?: boolean; mirrorAvailable?: number; createdProduct?: boolean } = {},
): Promise<{ productId: string; inventoryId: string; variantLinkId: string | null }> {
  const n = consecutivo++
  const stock = o.stock ?? 10
  const product = await prisma.product.create({
    data: {
      venueId: e.venueId,
      categoryId: e.categoryId,
      name: `Producto ${n}`,
      sku: o.sku ?? `SKU-${randomUUID().slice(0, 12)}`,
      price: D(100),
      unit: 'UNIT',
      type: 'REGULAR',
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    },
  })
  const inventory = await prisma.inventory.create({ data: { productId: product.id, venueId: e.venueId, currentStock: D(stock) } })
  // En CONNECTING/REVIEWING el guardia encola ese INSERT: cada prueba arranca sin filas.
  await prisma.shopifyStockOutbox.deleteMany({ where: { productId: product.id } })
  if (o.pareja === false) return { productId: product.id, inventoryId: inventory.id, variantLinkId: null }
  const variant = await prisma.shopifyVariantLink.create({
    data: {
      locationLinkId: e.locationLinkId,
      venueId: e.venueId,
      productId: product.id,
      shopifyProductId: `gid://shopify/Product/${n}`,
      shopifyVariantId: `gid://shopify/ProductVariant/${n}`,
      inventoryItemId: `gid://shopify/InventoryItem/${n}`,
      initializedAt: (o.initialized ?? true) ? new Date() : null,
      createdProduct: o.createdProduct ?? false,
      mirrorAvailable: o.mirrorAvailable ?? stock,
      mirrorAt: new Date(Date.now() - 5_000),
    },
  })
  return { productId: product.id, inventoryId: inventory.id, variantLinkId: variant.id }
}

/**
 * Lo que el invariante operativo (§9.3) no explica: Inventory − espejo − Σ(vivas + DEAD_LETTER) − offset de la revisión
 * OPEN, en la generación vigente de la pareja. `'0'` = cuadra. Vale para parejas iniciadas y no suspendidas.
 */
export async function huecoDelInvariante(productId: string): Promise<string> {
  const pareja = await prisma.shopifyVariantLink.findUniqueOrThrow({
    where: { productId },
    include: { locationLink: { select: { generation: true } } },
  })
  const inv = await prisma.inventory.findUniqueOrThrow({ where: { productId } })
  const filas = await prisma.shopifyStockOutbox.aggregate({
    where: {
      productId,
      locationLinkId: pareja.locationLinkId,
      generation: pareja.locationLink.generation,
      status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED', 'DEAD_LETTER'] },
    },
    _sum: { delta: true },
  })
  const revision = await prisma.shopifyReviewItem.aggregate({ where: { productId, status: 'OPEN' }, _sum: { offset: true } })
  return inv.currentStock
    .minus(pareja.mirrorAvailable)
    .minus(filas._sum.delta ?? 0)
    .minus(revision._sum.offset ?? 0)
    .toString()
}

/** Borra todo lo del escenario, en el orden que piden las llaves foráneas (Order, PurchaseOrder y Payment son RESTRICT). */
export async function limpiarEscenarioShopify(e: EscenarioShopify): Promise<void> {
  const { venueId } = e
  await prisma.shopifyStockOutbox.deleteMany({ where: { venueId } })
  await prisma.shopifyReviewItem.deleteMany({ where: { venueId } })
  await prisma.shopifyImportIssue.deleteMany({ where: { venueId } })
  await prisma.shopifyConnectIntent.deleteMany({ where: { venueId } })
  await prisma.shopifyInboundEvent.deleteMany({ where: { shopDomain: e.shopDomain } })
  await prisma.shopifyVariantLink.deleteMany({ where: { venueId } })
  await prisma.shopifyLocationLink.deleteMany({ where: { venueId } })
  await prisma.shopifyStore.deleteMany({ where: { organizationId: e.organizationId } })
  await prisma.notification.deleteMany({ where: { venueId } })
  await prisma.lowStockAlert.deleteMany({ where: { venueId } })
  // Vales por área V7 (orden de area-ticket-v7-flow.test.ts).
  await prisma.areaTicketFulfillment.deleteMany({ where: { fulfillmentArea: { venueId } } })
  await prisma.areaTicketPrintAttempt.deleteMany({ where: { areaTicket: { venueId } } })
  await prisma.areaTicketPaymentAttempt.deleteMany({ where: { checkoutSession: { venueId } } })
  await prisma.paymentAllocation.deleteMany({ where: { payment: { venueId } } })
  await prisma.payment.deleteMany({ where: { venueId } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
  await prisma.areaTicketInventoryReservation.deleteMany({ where: { venueId } })
  await prisma.areaTicketExternalSettlement.deleteMany({ where: { venueId } })
  await prisma.orderItemModifier.deleteMany({ where: { orderItem: { order: { venueId } } } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.areaTicket.deleteMany({ where: { venueId } })
  await prisma.areaTicketCheckoutSession.deleteMany({ where: { venueId } })
  await prisma.stockCount.deleteMany({ where: { venueId } })
  await prisma.inventoryWasteReport.deleteMany({ where: { venueId } })
  await prisma.inventoryPosting.deleteMany({ where: { venueId } })
  await prisma.purchaseOrder.deleteMany({ where: { venueId } })
  await prisma.supplier.deleteMany({ where: { venueId } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.inventory.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menu.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.fulfillmentArea.deleteMany({ where: { venueId } })
  await prisma.venueAreaTicketSettings.deleteMany({ where: { venueId } })
  await prisma.venueScaleSettings.deleteMany({ where: { venueId } })
  await prisma.venueFeature.deleteMany({ where: { venueId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  // La gente del negocio: el ADMIN del escenario y la que agreguen las pruebas (A5 crea más de 100), por tandas.
  const gente: string[] = [e.staffId]
  let cursor: string | undefined
  for (;;) {
    const tanda = await prisma.staffVenue.findMany({
      where: { venueId, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, staffId: true },
      orderBy: { id: 'asc' },
      take: 200,
    })
    gente.push(...tanda.map(t => t.staffId))
    if (tanda.length < 200) break
    cursor = tanda[tanda.length - 1].id
  }
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.staff.deleteMany({ where: { id: { in: gente } } })
  await prisma.organization.deleteMany({ where: { id: e.organizationId } })
}
