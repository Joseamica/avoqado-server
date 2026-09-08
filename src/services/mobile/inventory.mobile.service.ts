/**
 * Mobile Inventory Service
 *
 * Stock overview and stock count management for iOS/Android apps.
 */

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '../../errors/AppError'
import { MovementType, Prisma, RawMaterialMovementType, StockCountStatus } from '@prisma/client'
import { checkAndCreateLowStockAlert } from '../dashboard/rawMaterial.service'
import { createStockBatch, deductStockFIFOInTx } from '../dashboard/fifoBatch.service'
import { withSerializableRetry } from '../../utils/serializableRetry'
import { logAction } from '../dashboard/activity-log.service'
import { computeInventoryAvailability } from '../dashboard/product.dashboard.service'
import { resumirConteo, estadoParaClientes } from '../shared/stockCountSummary'

// NOTE: When full inventory management is implemented in mobile (iOS/Android),
// all CRUD operations (products, raw materials, recipes, suppliers, POs) must
// include logAction calls matching the dashboard pattern. See:
// - product.dashboard.service.ts (PRODUCT_CREATED/UPDATED/DELETED)
// - rawMaterial.service.ts (RAW_MATERIAL_CREATED/UPDATED/DELETED, STOCK_ADJUSTED)
// - recipe.service.ts (RECIPE_CREATED/UPDATED/DELETED)
// - supplier.service.ts (SUPPLIER_CREATED/UPDATED/DELETED)
// - purchaseOrder.service.ts (PURCHASE_ORDER_* actions)

export interface StockOverviewFilters {
  search?: string
  categoryId?: string
  sortBy?: 'name_asc' | 'name_desc' | 'stock_low' | 'stock_high'
}

/**
 * Get stock overview for a venue - products with inventory tracking enabled.
 */
export async function getStockOverview(venueId: string, page: number, pageSize: number, filters?: StockOverviewFilters) {
  const skip = (page - 1) * pageSize
  const take = pageSize

  const whereClause: any = {
    venueId,
    trackInventory: true,
    active: true,
    deletedAt: null,
  }

  if (filters?.search) {
    const term = filters.search.trim()
    whereClause.OR = [
      { name: { contains: term, mode: 'insensitive' } },
      { sku: { contains: term, mode: 'insensitive' } },
      { gtin: { contains: term, mode: 'insensitive' } },
    ]
  }

  if (filters?.categoryId) {
    whereClause.categoryId = filters.categoryId
  }

  // Determine ordering
  let orderBy: any = { name: 'asc' }
  if (filters?.sortBy === 'name_desc') orderBy = { name: 'desc' }
  // stock_low/stock_high will be sorted after query since stock is in a relation

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where: whereClause,
      include: {
        inventory: true,
        category: { select: { id: true, name: true } },
        // La receta es imprescindible para los productos con
        // inventoryMethod=RECIPE: su disponibilidad NO vive en `inventory`
        // (nunca tienen registro propio), se calcula desde los insumos.
        recipe: {
          include: {
            lines: {
              include: {
                rawMaterial: {
                  select: {
                    id: true,
                    name: true,
                    sku: true,
                    unit: true,
                    currentStock: true,
                    minimumStock: true,
                    avgCostPerUnit: true,
                    active: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy,
      skip,
      take,
    }),
    prisma.product.count({ where: whereClause }),
  ])

  const items = products.map(p => {
    const inv = p.inventory
    const reservedStock = inv ? Number(inv.reservedStock) : 0
    // 🔴 MISMA fuente de verdad que el POS y el dashboard. Antes esto hacía
    // `inventory?.currentStock ?? 0`, así que TODO producto por receta salía
    // en 0 (rojo, "agotado") aunque el POS lo vendiera sin problema: los
    // productos RECIPE nunca tienen registro propio en `inventory`, su
    // disponibilidad son las porciones que alcanzan los insumos.
    //
    // El administrador veía "Hamburguesa de Pollo: 0" mientras el mesero la
    // vendía con "Disponible: 33". Dos pantallas de la misma app, dos
    // verdades distintas. (Encontrado en una D3, 2026-07-28.)
    const { availableQuantity, availableQuantityExact, limitingIngredient } = computeInventoryAvailability(p)
    // El exacto primero: en un producto por peso `availableQuantity` viene
    // truncado a entero por compatibilidad, y la pantalla de Inventario es
    // justo donde el dueño necesita ver los 8.065 kg, no "8".
    const currentStock = availableQuantityExact ?? availableQuantity ?? (inv ? Number(inv.currentStock) : 0)
    return {
      id: p.id,
      name: p.name,
      sku: p.sku,
      gtin: p.gtin,
      imageUrl: p.imageUrl,
      categoryName: p.category?.name ?? null,
      unit: p.unit,
      onHand: currentStock,
      available: currentStock - reservedStock,
      onOrder: 0, // TODO: implement purchase orders
      // ADITIVOS: el cliente los usa para explicar QUÉ se acabó en un
      // producto por receta, en vez de un "0" sin causa. Los clientes viejos
      // los ignoran.
      inventoryMethod: p.inventoryMethod ?? null,
      limitingIngredientName: limitingIngredient?.name ?? null,
    }
  })

  // Sort by stock if requested
  if (filters?.sortBy === 'stock_low') {
    items.sort((a, b) => a.onHand - b.onHand)
  } else if (filters?.sortBy === 'stock_high') {
    items.sort((a, b) => b.onHand - a.onHand)
  }

  return {
    items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  }
}

// Alias: la regla vive en shared/stockCountSummary.ts (la usan /dashboard y el MCP).
const clientStockCountStatus = estadoParaClientes

type LockedStockCount = {
  id: string
  status: StockCountStatus
  revision: number
  applyingAt: Date | null
}

const STOCK_COUNT_REVISION_CONFLICT_MESSAGE = 'El conteo cambió desde que lo viste. Revisa el estado actual antes de continuar.'
const STOCK_COUNT_APPLYING_MESSAGE = 'Este conteo se está aplicando al inventario. Espera unos segundos y vuelve a intentarlo.'

function validateExpectedRevision(expectedRevision: number | undefined): void {
  if (expectedRevision !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision < 0)) {
    throw new BadRequestError('La revisión esperada debe ser un entero mayor o igual a cero')
  }
}

async function lockStockCount(tx: Prisma.TransactionClient, countId: string, venueId: string): Promise<LockedStockCount | null> {
  const rows = await tx.$queryRaw<LockedStockCount[]>`
    SELECT id, status, revision, "applyingAt"
    FROM "StockCount"
    WHERE id = ${countId} AND "venueId" = ${venueId}
    FOR UPDATE
  `
  return rows[0] ?? null
}

function throwRevisionConflict(locked: LockedStockCount, countId: string, venueId: string, expectedRevision: number): never {
  throw new ConflictError(STOCK_COUNT_REVISION_CONFLICT_MESSAGE, 'INVENTORY_COUNT_REVISION_CONFLICT', {
    venueId,
    countId,
    expectedRevision,
    currentRevision: locked.revision,
    status: locked.status,
  })
}

function assertExpectedRevision(locked: LockedStockCount, countId: string, venueId: string, expectedRevision?: number): void {
  if (expectedRevision !== undefined && locked.revision !== expectedRevision) {
    throwRevisionConflict(locked, countId, venueId, expectedRevision)
  }
}

function throwStockCountApplying(locked: LockedStockCount, countId: string, venueId: string): never {
  throw new ConflictError(STOCK_COUNT_APPLYING_MESSAGE, 'STOCK_COUNT_APPLYING', {
    venueId,
    countId,
    currentRevision: locked.revision,
    status: locked.status,
  })
}

/**
 * Get stock counts for a venue.
 */
export async function getStockCounts(venueId: string) {
  const counts = await prisma.stockCount.findMany({
    // 🔴 Un conteo CANCELLED no viaja a las apps, y quien lo obliga es iOS:
    // `enum StockCountStatus: String, Codable` sólo declara IN_PROGRESS y
    // COMPLETED, y `StockCount.status` no es opcional — UNA fila cancelada
    // tumba el decode del ARRAY entero (avoqado-ios
    // `Inventory/Models/InventoryModels.swift`). Android NO se rompe: allá
    // `status` es un `String` con rama `else -> status`
    // (`inventory/data/model/InventoryModels.kt`). La exclusión sigue siendo
    // obligatoria por iOS. El MCP y el dashboard sí los enseñan: los dos leen
    // por su cuenta (`services/dashboard/stockCountAudit.service.ts`), sin
    // este filtro.
    where: { venueId, status: { not: 'CANCELLED' } },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, sku: true, gtin: true, imageUrl: true } },
          rawMaterial: { select: { id: true, name: true, sku: true, gtin: true, unit: true } },
        },
      },
      createdByUser: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  return counts.map(c => ({
    id: c.id,
    revision: c.revision,
    type: c.type,
    status: clientStockCountStatus(c.status),
    note: c.note,
    createdAt: c.createdAt.toISOString(),
    createdBy: c.createdByUser ? `${c.createdByUser.firstName} ${c.createdByUser.lastName}` : null,
    itemCount: c.items.length,
    // Aditivo: qué se contó de verdad. Sólo líneas con countedAt.
    summary: resumirConteo(
      c.items.map(i => ({ expected: i.expected, counted: i.counted, countedAt: i.countedAt, unit: i.rawMaterial?.unit ?? null })),
    ),
    items: c.items.map(mapCountItem),
  }))
}

/**
 * Map a StockCountItem (product OR raw-material line) to the wire shape.
 * Compat: `productId` falls back to the raw material id so pre-ingredient
 * app versions (which decode it as non-optional) keep parsing; they can
 * still count the line because updates go by item.id. New clients switch
 * on `itemType` / `rawMaterialId`.
 */
export function mapCountItem(item: {
  id: string
  productId: string | null
  rawMaterialId: string | null
  expected: unknown
  counted: unknown
  countedAt: Date | null
  product: { name: string; sku: string | null; gtin: string | null; imageUrl: string | null } | null
  rawMaterial: { name: string; sku: string | null; gtin: string | null; unit: string } | null
}) {
  return {
    id: item.id,
    productId: item.productId ?? item.rawMaterialId,
    rawMaterialId: item.rawMaterialId,
    itemType: item.rawMaterialId ? 'RAW_MATERIAL' : 'PRODUCT',
    productName: item.product?.name ?? item.rawMaterial?.name ?? '',
    sku: item.product?.sku ?? item.rawMaterial?.sku ?? null,
    gtin: item.product?.gtin ?? item.rawMaterial?.gtin ?? null,
    imageUrl: item.product?.imageUrl ?? null,
    unit: item.rawMaterial?.unit ?? null,
    expected: Number(item.expected),
    // Se conserva como número aunque la línea no esté contada: un null aquí
    // revienta el Double no nulable de Android. La verdad de «¿se contó?» es
    // countedAt, no este número.
    counted: Number(item.counted),
    difference: Number(item.counted) - Number(item.expected),
    // null = todavía no se ha contado. Las apps lo leen como `yaSeConto`.
    countedAt: item.countedAt ? item.countedAt.toISOString() : null,
  }
}

/**
 * List active raw materials (ingredients) — for the cycle-count "add items"
 * picker and barcode matching in the counting flow.
 */
export async function getRawMaterials(venueId: string) {
  const rawMaterials = await prisma.rawMaterial.findMany({
    where: { venueId, active: true, deletedAt: null },
    select: { id: true, name: true, sku: true, gtin: true, unit: true, currentStock: true },
    orderBy: { name: 'asc' },
  })
  return rawMaterials.map(rm => ({
    id: rm.id,
    name: rm.name,
    sku: rm.sku,
    gtin: rm.gtin,
    unit: rm.unit,
    onHand: Number(rm.currentStock),
  }))
}

/**
 * Create a new stock count.
 */
export async function createStockCount(
  venueId: string,
  userId: string,
  type: 'CYCLE' | 'FULL',
  productIds?: string[],
  // Opt-in (additive): only clients that understand ingredient lines send
  // these — old app versions keep getting product-only counts.
  includeRawMaterials?: boolean,
  rawMaterialIds?: string[],
) {
  // For FULL count, get all products with inventory tracking
  let productsToCount: { id: string; currentStock: number }[] = []
  let rawMaterialsToCount: { id: string; currentStock: number }[] = []

  if (type === 'FULL') {
    // RECIPE products are excluded: their stock derives from ingredient
    // consumption, so physically counting the finished product is meaningless
    // (Square Recipes parity: counts cover QUANTITY products + ingredients).
    const products = await prisma.product.findMany({
      where: { venueId, trackInventory: true, active: true, deletedAt: null, inventoryMethod: { not: 'RECIPE' } },
      include: { inventory: true },
    })
    productsToCount = products.map(p => ({
      id: p.id,
      currentStock: p.inventory ? Number(p.inventory.currentStock) : 0,
    }))

    if (includeRawMaterials) {
      const rawMaterials = await prisma.rawMaterial.findMany({
        where: { venueId, active: true, deletedAt: null },
        select: { id: true, currentStock: true },
      })
      rawMaterialsToCount = rawMaterials.map(rm => ({ id: rm.id, currentStock: Number(rm.currentStock) }))
    }
  } else {
    if (productIds && productIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, venueId, active: true, deletedAt: null, inventoryMethod: { not: 'RECIPE' } },
        include: { inventory: true },
      })
      productsToCount = products.map(p => ({
        id: p.id,
        currentStock: p.inventory ? Number(p.inventory.currentStock) : 0,
      }))
    }
    if (rawMaterialIds && rawMaterialIds.length > 0) {
      const rawMaterials = await prisma.rawMaterial.findMany({
        where: { id: { in: rawMaterialIds }, venueId, active: true, deletedAt: null },
        select: { id: true, currentStock: true },
      })
      rawMaterialsToCount = rawMaterials.map(rm => ({ id: rm.id, currentStock: Number(rm.currentStock) }))
    }
  }

  // Un conteo sin líneas no es un conteo: el POS lo daría por "Completado" y el
  // gerente perdería el recorrido entero sin un solo aviso. Pasó de verdad —
  // mandó un producto con inventoryMethod RECIPE, que aquí se descarta a
  // propósito (su existencia se calcula desde los insumos), y el conteo se
  // guardó vacío. Mejor fallar aquí que archivar un conteo que miente.
  if (productsToCount.length === 0 && rawMaterialsToCount.length === 0) {
    throw new BadRequestError(
      'Ninguno de los artículos seleccionados se puede contar. Los artículos con receta no ' +
        'llevan existencia propia: cuenta sus insumos.',
    )
  }

  const count = await prisma.stockCount.create({
    data: {
      venueId,
      type,
      status: 'IN_PROGRESS',
      createdById: userId,
      items: {
        create: [
          ...productsToCount.map(p => ({
            productId: p.id,
            expected: p.currentStock,
            counted: 0,
          })),
          ...rawMaterialsToCount.map(rm => ({
            rawMaterialId: rm.id,
            expected: rm.currentStock,
            counted: 0,
          })),
        ],
      },
    },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, sku: true, gtin: true, imageUrl: true } },
          rawMaterial: { select: { id: true, name: true, sku: true, gtin: true, unit: true } },
        },
      },
    },
  })

  logAction({
    staffId: userId,
    venueId,
    action: 'STOCK_COUNT_CREATED',
    entity: 'StockCount',
    entityId: count.id,
    data: { type, itemCount: count.items.length, rawMaterialCount: rawMaterialsToCount.length, source: 'MOBILE' },
  })

  return {
    id: count.id,
    revision: count.revision,
    type: count.type,
    status: clientStockCountStatus(count.status),
    note: count.note,
    createdAt: count.createdAt.toISOString(),
    createdBy: null,
    itemCount: count.items.length,
    summary: resumirConteo(
      count.items.map(i => ({ expected: i.expected, counted: i.counted, countedAt: i.countedAt, unit: i.rawMaterial?.unit ?? null })),
    ),
    items: count.items.map(mapCountItem),
  }
}

/**
 * Update stock count items (set counted quantities).
 */
export async function updateStockCount(
  countId: string,
  venueId: string,
  items: { id: string; counted: number }[],
  note?: string,
  expectedRevision?: number,
) {
  validateExpectedRevision(expectedRevision)
  // Un conteo físico no puede ser negativo: nadie cuenta "menos siete
  // cervezas" en el anaquel. (El DELTA del ajuste sí puede serlo — contaste
  // menos de lo que el sistema creía; lo CONTADO, no.) Sin este guard, una
  // báscula con la tara mal puesta o un signo colado dejaban el inventario en
  // un valor imposible sin pasar por una venta — el único camino donde el
  // negativo es señal legítima. Todo-o-nada, ANTES de escribir nada.
  const negativo = items.find(item => item.counted < 0)
  if (negativo) {
    throw new BadRequestError('La cantidad contada no puede ser negativa')
  }

  return prisma.$transaction(async tx => {
    const locked = await lockStockCount(tx, countId, venueId)
    if (!locked) throw new NotFoundError('Conteo no encontrado o ya completado')
    assertExpectedRevision(locked, countId, venueId, expectedRevision)
    if (locked.status === 'APPLYING' && expectedRevision !== undefined) {
      throwStockCountApplying(locked, countId, venueId)
    }
    if (locked.status !== 'IN_PROGRESS') throw new NotFoundError('Conteo no encontrado o ya completado')

    // Tenant isolation: only fetch the requested ids, under the locked parent,
    // instead of hydrating every line in a potentially large FULL count.
    const requestedIds = [...new Set(items.map(item => item.id))]
    const ownedLines =
      requestedIds.length === 0
        ? []
        : await tx.stockCountItem.findMany({
            where: { stockCountId: countId, id: { in: requestedIds } },
            select: { id: true },
          })
    const ownedIds = new Set(ownedLines.map(item => item.id))
    if (requestedIds.some(id => !ownedIds.has(id))) {
      throw new BadRequestError('Una de las líneas no pertenece a este conteo')
    }

    await Promise.all(
      items.map(item =>
        tx.stockCountItem.update({
          where: { id: item.id },
          data: { counted: item.counted, countedAt: new Date() },
        }),
      ),
    )

    const updated = await tx.stockCount.update({
      where: { id: countId },
      data: { ...(note !== undefined ? { note } : {}), revision: { increment: 1 } },
      select: { revision: true },
    })
    return { success: true, revision: updated.revision }
  })
}

/**
 * «Dejarlo ir»: un borrador que nadie va a terminar. Sólo desde IN_PROGRESS.
 *
 * Reclamo atómico (updateMany condicional), igual que el claim del confirm:
 * dos cancelaciones, o una cancelación contra un confirm en vuelo, no se
 * pisan — quien pierde el reclamo recibe el motivo real. Un conteo cancelado
 * nunca ajustó el inventario; se conserva para consulta.
 */
export async function cancelStockCount(countId: string, venueId: string, userId: string, expectedRevision?: number) {
  validateExpectedRevision(expectedRevision)
  const result = await prisma.$transaction(async tx => {
    const locked = await lockStockCount(tx, countId, venueId)
    if (!locked) throw new NotFoundError('Conteo no encontrado')
    assertExpectedRevision(locked, countId, venueId, expectedRevision)
    if (locked.status === 'CANCELLED') throw new ConflictError('Este conteo ya estaba cancelado')
    if (locked.status === 'APPLYING') {
      if (expectedRevision !== undefined) throwStockCountApplying(locked, countId, venueId)
      throw new ConflictError('Este conteo se está aplicando al inventario; espera a que termine')
    }
    if (locked.status === 'COMPLETED') throw new ConflictError('Un conteo completado no se puede cancelar: ya ajustó el inventario')

    const cancelledAt = new Date()
    const claim = await tx.stockCount.updateMany({
      where: { id: countId, venueId, status: 'IN_PROGRESS', revision: locked.revision },
      data: { status: 'CANCELLED', cancelledAt, revision: { increment: 1 } },
    })
    if (claim.count === 0) {
      throw new ConflictError('El conteo cambió mientras intentabas cancelarlo. Revisa su estado actual.')
    }
    return { id: countId, status: 'CANCELLED' as const, cancelledAt: cancelledAt.toISOString(), revision: locked.revision + 1 }
  })

  logAction({
    staffId: userId,
    venueId,
    action: 'STOCK_COUNT_CANCELLED',
    entity: 'StockCount',
    entityId: countId,
    data: { cancelledAt: result.cancelledAt, revision: result.revision },
  })

  return result
}

/**
 * Confirm a stock count - applies inventory adjustments.
 *
 * 🔴 CLAIM ATÓMICO + SET EN TX CON RELECTURA (fase 3, 2026-08-13):
 *
 * - Doble-confirm: dos confirmaciones concurrentes pasaban ambas el check de
 *   status (leído fuera de toda transacción) y aplicaban los ajustes DOS veces.
 *   Ahora el claim IN_PROGRESS→COMPLETED es un updateMany condicional: solo
 *   quien lo gana aplica; el perdedor recibe 404.
 * - TOCTOU: el delta se calculaba contra el snapshot cargado al ABRIR la
 *   confirmación; una venta en la ventana quedaba pisada por el SET y el
 *   movimiento guardaba un previousStock mentiroso. Ahora cada línea relee su
 *   stock DENTRO de su transacción con FOR UPDATE y aplica contra ese valor.
 * - Si la aplicación falla, el claim se revierte a IN_PROGRESS (mejor esfuerzo)
 *   para que el cajero pueda reintentar; re-confirmar es seguro porque cada
 *   línea vuelve a medir su delta contra el stock fresco.
 * - 🔴 COMPLETED se estampa AL FINAL, no como claim (auditoría 2026-08-13): el
 *   claim ahora es IN_PROGRESS→APPLYING. Antes el claim marcaba COMPLETED
 *   primero; un crash a media aplicación (o un revert fallido) dejaba un conteo
 *   "completado" con cero ajustes aplicados y SIN camino de reintento — el
 *   propio guard del claim respondía "ya completado". Un APPLYING huérfano
 *   (lease vencido) sí puede re-reclamarse: re-aplicar es seguro porque cada
 *   línea mide su delta contra el stock fresco (las ya aplicadas dan delta 0).
 */

/** Un APPLYING más viejo que esto es un worker muerto: el conteo se re-reclama. */
const STOCK_COUNT_APPLYING_LEASE_MS = 2 * 60 * 1000

export async function confirmStockCount(countId: string, venueId: string, userId: string, expectedRevision?: number) {
  validateExpectedRevision(expectedRevision)
  const claimResult = await prisma.$transaction(async tx => {
    const locked = await lockStockCount(tx, countId, venueId)
    if (!locked) throw new NotFoundError('Conteo no encontrado o ya completado')

    if (locked.status === 'COMPLETED' && expectedRevision !== undefined && locked.revision === expectedRevision + 1) {
      return { alreadyCompleted: true as const, revision: locked.revision }
    }
    assertExpectedRevision(locked, countId, venueId, expectedRevision)
    if (locked.status === 'COMPLETED' || locked.status === 'CANCELLED') {
      throw new NotFoundError('Conteo no encontrado o ya completado')
    }

    const staleBefore = new Date(Date.now() - STOCK_COUNT_APPLYING_LEASE_MS)
    const staleApplying = locked.status === 'APPLYING' && locked.applyingAt !== null && locked.applyingAt < staleBefore
    if (locked.status === 'APPLYING' && !staleApplying) {
      if (expectedRevision !== undefined) throwStockCountApplying(locked, countId, venueId)
      throw new NotFoundError('Conteo no encontrado, en proceso o ya completado')
    }

    // The parent lock is held before this coherent snapshot is loaded. PUT and
    // cancel use the same lock, so neither can mutate the aggregate between
    // the snapshot and the APPLYING claim.
    const count = await tx.stockCount.findFirst({
      where: { id: countId, venueId },
      include: {
        items: {
          include: {
            product: { include: { inventory: true } },
            rawMaterial: { select: { id: true, name: true, currentStock: true, unit: true } },
          },
        },
      },
    })
    if (!count) throw new NotFoundError('Conteo no encontrado o ya completado')

    const countedItems = count.items.filter(item => item.countedAt !== null)
    if (countedItems.some(item => Number(item.counted) < 0)) {
      throw new BadRequestError('La cantidad contada no puede ser negativa. Corrige la línea y vuelve a confirmar.')
    }

    const claimStamp = new Date()
    const claim = await tx.stockCount.updateMany({
      where: {
        id: countId,
        venueId,
        revision: locked.revision,
        OR: [{ status: 'IN_PROGRESS' }, { status: 'APPLYING', applyingAt: { lt: staleBefore } }],
      },
      data: { status: 'APPLYING', applyingAt: claimStamp },
    })
    if (claim.count === 0) throw new NotFoundError('Conteo no encontrado, en proceso o ya completado')

    return { alreadyCompleted: false as const, revision: locked.revision, claimStamp, countedItems }
  })

  if (claimResult.alreadyCompleted) return { success: true, revision: claimResult.revision }
  const { claimStamp, countedItems, revision: baseRevision } = claimResult

  // Ajustes realmente aplicados (con el stock fresco de cada tx) — es lo que
  // se audita; el resumen contra `expected` mentía e incluía líneas no contadas.
  const appliedAdjustments: Array<{
    productId: string | null
    productName: string
    previous: number
    counted: number
    difference: number
  }> = []

  try {
    // ── Insumos: la verdad es el conteo físico → SET contra relectura ────────
    const ingredientFailures: { rawMaterialId: string; name: string; error: string }[] = []
    for (const item of countedItems) {
      if (!item.rawMaterialId || !item.rawMaterial) continue
      // 🔴 Idempotencia por línea (audit 2026-08-13): una línea con sello
      // appliedAt YA aplicó en un intento anterior — re-aplicarla re-SETearía
      // el stock al valor contado y borraría las ventas ocurridas después del
      // crash del worker original.
      if (item.appliedAt) continue
      const rawMaterialId = item.rawMaterialId
      const counted = Number(item.counted)
      const reason = `Conteo de inventario #${countId}`

      try {
        const applied = await withSerializableRetry(
          async tx => {
            // 🛡️ CLAIM por línea DENTRO de la tx (cerca contra el worker
            // original resucitado): el `item.appliedAt` del pre-read puede ser
            // stale — un reemplazo pudo aplicar esta línea después de que este
            // worker la cargó. Solo quien voltea appliedAt NULL→now aplica; el
            // sello y el efecto commitean (o se revierten) JUNTOS, y el row
            // lock del updateMany serializa a los dos workers.
            const lineClaim = await tx.stockCountItem.updateMany({
              where: { id: item.id, appliedAt: null },
              data: { appliedAt: new Date() },
            })
            if (lineClaim.count === 0) {
              return { delta: 0, previous: 0, batch: null as any }
            }
            const lineResult = await (async () => {
              // Relectura CON CANDADO: el delta se mide contra el stock del
              // momento de aplicar, no contra el snapshot de la apertura.
              const rows = await tx.$queryRaw<
                Array<{ currentStock: unknown; unit: string; costPerUnit: unknown; perishable: boolean; shelfLifeDays: number | null }>
              >`
              SELECT "currentStock", unit, "costPerUnit", perishable, "shelfLifeDays"
              FROM "RawMaterial"
              WHERE id = ${rawMaterialId} AND "venueId" = ${venueId}
              FOR UPDATE
            `
              if (rows.length === 0) {
                throw new NotFoundError(`Insumo ${rawMaterialId} no encontrado en esta sucursal`)
              }
              const fresh = rows[0]
              const current = Number(fresh.currentStock)
              const delta = counted - current

              if (delta === 0) {
                await tx.rawMaterial.update({ where: { id: rawMaterialId }, data: { lastCountAt: new Date() } })
                return { delta, previous: current, batch: null as any }
              }

              if (delta < 0) {
                try {
                  await deductStockFIFOInTx(tx, venueId, rawMaterialId, Math.abs(delta), RawMaterialMovementType.COUNT, {
                    reason,
                    createdBy: userId,
                  })
                  await tx.rawMaterial.update({ where: { id: rawMaterialId }, data: { lastCountAt: new Date() } })
                  return { delta, previous: current, batch: null as any }
                } catch (error) {
                  // Fallback SOLO para el hueco legítimo: insumo seed/legacy con
                  // saldo pero sin lotes ACTIVE (o con menos lote que saldo). El
                  // catch-all anterior tragaba CUALQUIER error y rompía el
                  // invariante currentStock == Σ lotes ACTIVE sin avisar.
                  const message = error instanceof Error ? error.message : String(error)
                  const isBatchGap = message.includes('No active batches') || message.includes('Insufficient stock')
                  if (!isBatchGap) throw error

                  await tx.rawMaterial.update({
                    where: { id: rawMaterialId },
                    data: { currentStock: counted, lastCountAt: new Date() },
                  })
                  await tx.rawMaterialMovement.create({
                    data: {
                      rawMaterialId,
                      venueId,
                      type: RawMaterialMovementType.COUNT,
                      quantity: delta,
                      unit: (fresh.unit as any) ?? 'PIECE',
                      previousStock: current,
                      newStock: counted,
                      reason: `${reason} (ajuste directo, sin lotes)`,
                      createdBy: userId,
                    },
                  })
                  return { delta, previous: current, batch: null as any }
                }
              }

              // delta > 0: el excedente contado entra como lote nuevo (misma
              // mecánica que adjustStock) para conservar currentStock == Σ lotes.
              const created = await createStockBatch(
                venueId,
                rawMaterialId,
                {
                  quantity: delta,
                  unit: fresh.unit as any,
                  costPerUnit: Number(fresh.costPerUnit ?? 0),
                  receivedDate: new Date(),
                  expirationDate:
                    fresh.perishable && fresh.shelfLifeDays ? new Date(Date.now() + fresh.shelfLifeDays * 24 * 60 * 60 * 1000) : undefined,
                },
                userId,
                tx,
                { skipAudit: true },
              )

              await tx.rawMaterial.update({
                where: { id: rawMaterialId },
                data: { currentStock: { increment: delta }, lastCountAt: new Date() },
              })

              await tx.rawMaterialMovement.create({
                data: {
                  rawMaterialId,
                  venueId,
                  batchId: created.id,
                  type: RawMaterialMovementType.COUNT,
                  quantity: delta,
                  unit: fresh.unit as any,
                  previousStock: current,
                  newStock: counted,
                  costImpact: Number(fresh.costPerUnit ?? 0) * delta,
                  reason,
                  createdBy: userId,
                },
              })
              return { delta, previous: current, batch: created }
            })()

            return lineResult
          },
          { timeoutMs: 10_000, maxRetries: 3, baseDelayMs: 40 },
        )

        // Post-commit (fire-and-forget): auditoría y alertas fuera de la tx.
        if (applied.batch) {
          void logAction({
            staffId: userId,
            venueId,
            action: 'STOCK_BATCH_CREATED',
            entity: 'StockBatch',
            entityId: applied.batch.id,
            data: { batchNumber: applied.batch.batchNumber, rawMaterialId, quantity: applied.delta },
          })
        }
        if (applied.delta !== 0) {
          void logAction({
            staffId: userId,
            venueId,
            action: 'STOCK_ADJUSTED',
            entity: 'RawMaterial',
            entityId: rawMaterialId,
            data: { name: (item.rawMaterial as any).name ?? rawMaterialId, quantity: applied.delta, type: RawMaterialMovementType.COUNT },
          })
          await checkAndCreateLowStockAlert(venueId, rawMaterialId)
          appliedAdjustments.push({
            productId: rawMaterialId,
            productName: (item.rawMaterial as any).name ?? rawMaterialId,
            previous: applied.previous,
            counted,
            difference: applied.delta,
          })
        }
      } catch (error) {
        ingredientFailures.push({
          rawMaterialId,
          name: (item.rawMaterial as any).name ?? rawMaterialId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    if (ingredientFailures.length > 0) {
      throw new Error(`No se pudo ajustar ${ingredientFailures.length} insumo(s): ${ingredientFailures.map(f => f.name).join(', ')}`)
    }

    // ── Productos: SET contra relectura FOR UPDATE dentro de su tx ──────────
    for (const item of countedItems) {
      if (!item.product) continue
      // Idempotencia por línea: ya aplicada en un intento anterior (ver arriba).
      if (item.appliedAt) continue

      const inventory = item.product.inventory
      if (!inventory) continue

      const counted = Number(item.counted)
      const applied = await prisma.$transaction(async tx => {
        // 🛡️ CLAIM por línea dentro de la tx (mismo patrón que los insumos):
        // el appliedAt del pre-read puede ser stale para un worker resucitado;
        // solo quien voltea NULL→now aplica, y sello+efecto commitean juntos.
        const lineClaim = await tx.stockCountItem.updateMany({
          where: { id: item.id, appliedAt: null },
          data: { appliedAt: new Date() },
        })
        if (lineClaim.count === 0) return null

        const rows = await tx.$queryRaw<Array<{ currentStock: unknown }>>`
          SELECT "currentStock" FROM "Inventory" WHERE id = ${inventory.id} FOR UPDATE
        `
        const previousStock = rows.length > 0 ? Number(rows[0].currentStock) : Number(inventory.currentStock)
        const difference = counted - previousStock
        if (difference === 0) return null

        await tx.inventory.update({
          where: { id: inventory.id },
          data: {
            currentStock: counted,
            lastCountedAt: new Date(),
          },
        })
        await tx.inventoryMovement.create({
          data: {
            inventoryId: inventory.id,
            type: MovementType.COUNT,
            quantity: difference,
            previousStock,
            newStock: counted,
            reason: `Conteo de inventario #${countId}`,
            createdBy: userId,
          },
        })
        return { previousStock, difference }
      })

      if (applied) {
        appliedAdjustments.push({
          productId: item.productId,
          productName: (item.product as any)?.name ?? item.productId ?? '',
          previous: applied.previousStock,
          counted,
          difference: applied.difference,
        })
      }
    }
  } catch (error) {
    // Revertir el claim (mejor esfuerzo) para que el cajero pueda reintentar de
    // inmediato. Si este revert también falla, el conteo queda APPLYING — que
    // NO es terminal: tras el lease se puede volver a reclamar. Nunca queda un
    // COMPLETED mentiroso con líneas sin aplicar.
    //
    // 🛡️ CERCADO con el sello del claim (audit ronda 4): un worker resucitado
    // cuyo lease ya fue re-reclamado NO puede regresar a IN_PROGRESS el conteo
    // que el reemplazo tiene APPLYING (o ya completó) — eso reabría la edición
    // de un conteo cuyas líneas selladas ya no se re-aplican.
    await prisma.stockCount
      .updateMany({
        where: { id: countId, venueId, status: 'APPLYING', applyingAt: claimStamp, revision: baseRevision },
        data: { status: 'IN_PROGRESS', completedAt: null, applyingAt: null },
      })
      .catch(() => undefined)
    throw error
  }

  // 🔴 COMPLETED se estampa DESPUÉS de aplicar todo: si el proceso muere antes
  // de esta línea, el conteo queda APPLYING (recuperable), no "completado".
  // 🛡️ También cercado por el sello: si otro worker re-reclamó, él decide.
  const completed = await prisma.stockCount.updateMany({
    where: { id: countId, venueId, status: 'APPLYING', applyingAt: claimStamp, revision: baseRevision },
    data: { status: 'COMPLETED', completedAt: new Date(), applyingAt: null, revision: { increment: 1 } },
  })
  if (completed.count === 0) {
    logger.warn('🛡️ [StockCount] Cierre perdido: otro worker re-reclamó el conteo — el nuevo dueño decide el estado final', {
      countId,
      venueId,
    })
    // 🔴 NO se reporta éxito ni se audita STOCK_COUNT_CONFIRMED: el reemplazo
    // sigue aplicando (o puede revertir) — decir "completado" aquí mentiría al
    // cliente y a la bitácora. Las líneas que ESTE worker sí aplicó quedan
    // selladas (appliedAt) y el dueño del claim termina el trabajo.
    throw new ConflictError('Otro dispositivo está aplicando este conteo. Verifica su estado en unos segundos.', 'STOCK_COUNT_RECLAIMED')
  }

  logAction({
    staffId: userId,
    venueId,
    action: 'STOCK_COUNT_CONFIRMED',
    entity: 'StockCount',
    entityId: countId,
    data: { adjustmentsCount: appliedAdjustments.length, adjustments: appliedAdjustments, revision: baseRevision + 1, source: 'MOBILE' },
  })

  return { success: true, revision: baseRevision + 1 }
}
