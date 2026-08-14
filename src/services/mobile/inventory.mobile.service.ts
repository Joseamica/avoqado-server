/**
 * Mobile Inventory Service
 *
 * Stock overview and stock count management for iOS/Android apps.
 */

import prisma from '../../utils/prismaClient'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import { MovementType, RawMaterialMovementType } from '@prisma/client'
import { checkAndCreateLowStockAlert } from '../dashboard/rawMaterial.service'
import { createStockBatch, deductStockFIFOInTx } from '../dashboard/fifoBatch.service'
import { withSerializableRetry } from '../../utils/serializableRetry'
import { logAction } from '../dashboard/activity-log.service'
import { computeInventoryAvailability } from '../dashboard/product.dashboard.service'

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

/**
 * APPLYING es un estado interno del server (claim del confirm). Las apps
 * distribuidas solo conocen IN_PROGRESS/COMPLETED — mandarles un valor nuevo
 * rompe sus decoders (contrato /mobile: nunca cambiar valores de respuesta).
 * Para el cliente, un conteo aplicándose sigue "en progreso".
 */
const clientStockCountStatus = (status: string): string => (status === 'APPLYING' ? 'IN_PROGRESS' : status)

/**
 * Get stock counts for a venue.
 */
export async function getStockCounts(venueId: string) {
  const counts = await prisma.stockCount.findMany({
    where: { venueId },
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
    type: c.type,
    status: clientStockCountStatus(c.status),
    note: c.note,
    createdAt: c.createdAt.toISOString(),
    createdBy: c.createdByUser ? `${c.createdByUser.firstName} ${c.createdByUser.lastName}` : null,
    itemCount: c.items.length,
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
function mapCountItem(item: {
  id: string
  productId: string | null
  rawMaterialId: string | null
  expected: unknown
  counted: unknown
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
    counted: Number(item.counted),
    difference: Number(item.counted) - Number(item.expected),
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
    type: count.type,
    status: clientStockCountStatus(count.status),
    note: count.note,
    createdAt: count.createdAt.toISOString(),
    createdBy: null,
    itemCount: count.items.length,
    items: count.items.map(mapCountItem),
  }
}

/**
 * Update stock count items (set counted quantities).
 */
export async function updateStockCount(countId: string, venueId: string, items: { id: string; counted: number }[], note?: string) {
  const count = await prisma.stockCount.findFirst({
    where: { id: countId, venueId, status: 'IN_PROGRESS' },
  })

  if (!count) {
    throw new NotFoundError('Conteo no encontrado o ya completado')
  }

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

  // 🔴 Tenant isolation (audit Codex 2026-08-12): el conteo ya se validó contra
  // el venue, pero las LÍNEAS llegaban por id pelón — un usuario del venue A
  // podía mutar líneas de un conteo del venue B mandando sus ids en el body.
  // Todo-o-nada, ANTES de escribir nada.
  const lineasDelConteo = new Set(
    (await prisma.stockCountItem.findMany({ where: { stockCountId: countId }, select: { id: true } })).map(item => item.id),
  )
  const ajena = items.find(item => !lineasDelConteo.has(item.id))
  if (ajena) {
    throw new BadRequestError('Una de las líneas no pertenece a este conteo')
  }

  // Update each item's counted quantity
  await Promise.all(
    items.map(item =>
      prisma.stockCountItem.update({
        where: { id: item.id },
        data: { counted: item.counted, countedAt: new Date() },
      }),
    ),
  )

  // Optionally update note
  if (note !== undefined) {
    await prisma.stockCount.update({
      where: { id: countId },
      data: { note },
    })
  }

  return { success: true }
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

export async function confirmStockCount(countId: string, venueId: string, userId: string) {
  const count = await prisma.stockCount.findFirst({
    // APPLYING entra al pre-read para que el reintento tras un crash pueda
    // cargar el conteo; el claim de abajo decide si de verdad puede aplicarlo.
    where: { id: countId, venueId, status: { in: ['IN_PROGRESS', 'APPLYING'] } },
    include: {
      items: {
        include: {
          product: { include: { inventory: true } },
          rawMaterial: { select: { id: true, name: true, currentStock: true, unit: true } },
        },
      },
    },
  })

  if (!count) {
    throw new NotFoundError('Conteo no encontrado o ya completado')
  }

  // Only lines the cashier actually counted are applied: an untouched line
  // sits at the default counted=0, and applying it would zero out real stock
  // (this bit the E2E test — 46 untouched ingredients started wiping stock).
  const countedItems = count.items.filter(item => item.countedAt !== null)

  // Defensa en la frontera del EFECTO (audit Codex 2026-08-12): un negativo
  // ALMACENADO antes del deploy —o colado por otra vía— no debe aplicarse
  // jamás al inventario. Un conteo físico no puede ser negativo.
  if (countedItems.some(item => Number(item.counted) < 0)) {
    throw new BadRequestError('La cantidad contada no puede ser negativa. Corrige la línea y vuelve a confirmar.')
  }

  // Claim atómico ANTES de aplicar: mata el doble-confirm en la raíz. El claim
  // es APPLYING (no COMPLETED): completar se gana aplicando, no reclamando.
  const claim = await prisma.stockCount.updateMany({
    where: {
      id: countId,
      venueId,
      OR: [
        { status: 'IN_PROGRESS' },
        // Rescate: un worker que murió a media aplicación dejó APPLYING; tras
        // el lease, el reintento del cajero puede volver a reclamarlo.
        { status: 'APPLYING', applyingAt: { lt: new Date(Date.now() - STOCK_COUNT_APPLYING_LEASE_MS) } },
      ],
    },
    data: { status: 'APPLYING', applyingAt: new Date() },
  })
  if (claim.count === 0) {
    throw new NotFoundError('Conteo no encontrado, en proceso o ya completado')
  }

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
      const rawMaterialId = item.rawMaterialId
      const counted = Number(item.counted)
      const reason = `Conteo de inventario #${countId}`

      try {
        const applied = await withSerializableRetry(
          async tx => {
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

      const inventory = item.product.inventory
      if (!inventory) continue

      const counted = Number(item.counted)
      const applied = await prisma.$transaction(async tx => {
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
    await prisma.stockCount
      .update({ where: { id: countId }, data: { status: 'IN_PROGRESS', completedAt: null, applyingAt: null } })
      .catch(() => undefined)
    throw error
  }

  // 🔴 COMPLETED se estampa DESPUÉS de aplicar todo: si el proceso muere antes
  // de esta línea, el conteo queda APPLYING (recuperable), no "completado".
  await prisma.stockCount.update({
    where: { id: countId },
    data: { status: 'COMPLETED', completedAt: new Date(), applyingAt: null },
  })

  logAction({
    staffId: userId,
    venueId,
    action: 'STOCK_COUNT_CONFIRMED',
    entity: 'StockCount',
    entityId: countId,
    data: { adjustmentsCount: appliedAdjustments.length, adjustments: appliedAdjustments, source: 'MOBILE' },
  })

  return { success: true }
}
