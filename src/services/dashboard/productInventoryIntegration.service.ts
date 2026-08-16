import { MovementType } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import AppError from '../../errors/AppError'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { deductStockForModifiers, deductStockForRecipe, OrderModifierForInventory } from './rawMaterial.service'
import { logAction } from './activity-log.service'

/**
 * Product Inventory Integration Service
 * Handles different inventory models for different business types:
 * - NONE: Services (classes, consultations) - no inventory tracking
 * - QUANTITY: Retail (jewelry, clothing) - direct unit counting
 * - RECIPE: Restaurants - ingredient-based costing (FIFO)
 *
 * ✅ WORLD-CLASS PATTERN: Toast/Square/Shopify naming
 */

export type InventoryMethod = 'QUANTITY' | 'RECIPE'

/**
 * Determine inventory method based on product configuration
 * Returns null if product doesn't track inventory
 */
export async function getProductInventoryMethod(productId: string): Promise<InventoryMethod | null> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      recipe: {
        select: {
          id: true,
        },
      },
      venue: {
        select: {
          features: {
            where: {
              feature: {
                code: 'INVENTORY_TRACKING',
              },
            },
            select: {
              active: true,
            },
          },
        },
      },
    },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  // If product doesn't track inventory, return null
  if (!product.trackInventory) {
    return null
  }

  // ✅ WORLD-CLASS: Read from dedicated column (not JSON!)
  // Use explicit inventoryMethod if set
  if (product.inventoryMethod) {
    return product.inventoryMethod
  }

  // Fallback for legacy products: infer from relations
  if (product.recipe) {
    return 'RECIPE'
  }

  // Default: null (no tracking)
  return null
}

/**
 * Batch variant of getProductInventoryMethod: classifies N products with ONE
 * query. Nació para createSalePostingInTx, que clasificaba item por item
 * DENTRO de la transacción del cobro (N+1 sobre la ruta del dinero, contra el
 * timeout de 5s de la tx interactiva). Un producto inexistente simplemente no
 * aparece en el mapa — el caller decide (el posting lo trata como no-deducible).
 *
 * @param client - pásale la tx cuando corras dentro de una transacción; así la
 *                 consulta usa la MISMA conexión en vez de pedir otra al pool.
 */
export async function getProductInventoryMethods(
  productIds: string[],
  client: Pick<typeof prisma, 'product'> = prisma,
  // 🔴 Aislamiento por tenant (fase 5, audit Codex): sin este filtro la
  // clasificación sólo miraba el productId, así que un camino de cobro que
  // acepta un `orderId` externo sin verificar el negocio (B4BIT, links) podía
  // acabar creando una línea de deducción contra el producto de OTRO venue.
  // Opcional para no romper los callers legacy; los caminos de venta SÍ lo pasan.
  venueId?: string,
): Promise<Map<string, InventoryMethod | null>> {
  const methods = new Map<string, InventoryMethod | null>()
  const uniqueIds = [...new Set(productIds)].filter(Boolean)
  if (uniqueIds.length === 0) return methods

  const products = await client.product.findMany({
    where: { id: { in: uniqueIds }, ...(venueId ? { venueId } : {}) },
    select: {
      id: true,
      trackInventory: true,
      inventoryMethod: true,
      recipe: { select: { id: true } },
    },
  })

  for (const product of products) {
    if (!product.trackInventory) {
      methods.set(product.id, null)
    } else if (product.inventoryMethod) {
      methods.set(product.id, product.inventoryMethod)
    } else if (product.recipe) {
      methods.set(product.id, 'RECIPE')
    } else {
      methods.set(product.id, null)
    }
  }

  return methods
}

/**
 * Process inventory deduction when a product is sold
 * Automatically determines the correct method based on inventory configuration
 *
 * ✅ WORLD-CLASS: Supports modifier inventory tracking (Toast/Square pattern)
 * - ADDITION modifiers: Add extra ingredients on top of the recipe
 * - SUBSTITUTION modifiers: Replace variable ingredients in the recipe
 *
 * @param orderModifiers - Optional: Modifiers selected for this order item
 */
export async function deductInventoryForProduct(
  venueId: string,
  productId: string,
  quantity: number,
  orderId: string,
  staffId?: string,
  orderModifiers?: OrderModifierForInventory[],
  // Fase 2 (posting durable): liga los movimientos QUANTITY a su línea de
  // posting. Opcional y aditivo — los callers legacy no cambian.
  options?: { postingLineId?: string },
) {
  const inventoryMethod = await getProductInventoryMethod(productId)

  // Venta por peso (fase 3, 2026-08-13): en una línea pesada los callers pasan
  // `quantity` = KILOS pesados (effectiveQuantity), y esas líneas siempre
  // llevan quantity=1. Los modificadores ADDITION son POR LÍNEA (una selección
  // por renglón): escalar "extra salsa" por los kilos deducía 0.435× o 2.5× lo
  // configurado. La receta/el stock del producto SÍ escalan por kilos — solo
  // la escala del modificador se corrige. Se resuelve AQUÍ para cubrir a todos
  // los callers (TPV, pagos, payment links, dashboard) sin tocarlos.
  let modifierScaleQuantity = quantity
  if (orderModifiers?.length) {
    const productScale = await prisma.product.findUnique({
      where: { id: productId },
      select: { soldByWeight: true },
    })
    if (productScale?.soldByWeight) {
      modifierScaleQuantity = 1
    }
  }

  // No inventory tracking for product
  if (!inventoryMethod) {
    // ✅ Still process ADDITION modifiers even if product doesn't track inventory
    // Example: "Extra Bacon" on a product without recipe tracking
    if (orderModifiers?.length) {
      await deductStockForModifiers(venueId, modifierScaleQuantity, orderModifiers, orderId, staffId, options?.postingLineId)
    }
    return {
      inventoryMethod: null,
      message: orderModifiers?.length ? 'No product inventory, modifiers processed' : 'No inventory deduction needed',
    }
  }

  switch (inventoryMethod) {
    case 'QUANTITY': {
      const result = await deductSimpleStock(venueId, productId, quantity, orderId, staffId, options?.postingLineId)
      // ✅ Also deduct ADDITION modifiers for QUANTITY products
      if (orderModifiers?.length) {
        await deductStockForModifiers(venueId, modifierScaleQuantity, orderModifiers, orderId, staffId, options?.postingLineId)
      }
      return result
    }

    case 'RECIPE': {
      // ✅ Pass modifiers to recipe deduction (handles SUBSTITUTION)
      const result = await deductRecipeBasedInventory(
        venueId,
        productId,
        quantity,
        orderId,
        staffId,
        orderModifiers,
        options?.postingLineId,
      )
      // ✅ Also deduct ADDITION modifiers (SUBSTITUTION handled in deductStockForRecipe)
      if (orderModifiers?.length) {
        await deductStockForModifiers(venueId, modifierScaleQuantity, orderModifiers, orderId, staffId, options?.postingLineId)
      }
      return result
    }

    default:
      throw new AppError(`Unknown inventory method: ${inventoryMethod}`, 500)
  }
}

/**
 * Deduct simple stock (for retail products like jewelry, clothing)
 * ✅ FIX (2025-11-29): Uses Inventory table consistently
 * - Status check uses Inventory table (getProductInventoryStatus)
 * - Deduction uses Inventory table (this function)
 * - Movement tracked in InventoryMovement table
 *
 * This ensures QUANTITY products have a single source of truth
 * (unlike the previous implementation that used RawMaterial for deduction)
 */
/**
 * Deduct simple stock (for retail products like jewelry, clothing)
 * ✅ FIX (2026-01-16): Uses ATOMIC DECREMENT to prevent race conditions
 * - Uses interactive transaction to ensure consistency
 * - Decrements stock atomically
 * - Creates movement log with correct values
 */
async function deductSimpleStock(
  venueId: string,
  productId: string,
  quantity: number,
  orderId: string,
  staffId?: string,
  postingLineId?: string,
) {
  const result = await prisma.$transaction(async tx => {
    // 1. Get product for metadata
    const product = await tx.product.findUnique({
      where: { id: productId },
    })

    if (!product) {
      throw new AppError('Product not found', 404)
    }

    // 2. UNCONDITIONAL ATOMIC DECREMENT — single SQL statement, race-safe by
    // itself. El stock PUEDE quedar negativo, y es a propósito (decisión
    // founder+Claude 2026-08-12, espejo de Square): una venta COBRADA es un
    // hecho — el producto ya salió por la puerta — y el registro tiene que
    // anotarla aunque el número guardado estuviera desfasado. El negativo ES
    // la señal de descuadre que el dueño necesita ver ("vendiste 3 y yo tenía
    // 2 anotadas: algo no se está capturando").
    //
    // 🔴 Historia, para que nadie lo "arregle" de vuelta: este decremento fue
    // condicional (`AND currentStock >= qty`) y con stock insuficiente lanzaba
    // "Insufficient stock" — lo que arriba REVERTÍA una orden ya cobrada a
    // PENDING: cliente pagado, cuenta abierta, y sin señal en inventario. La
    // condición nació de un E2E destructivo (2026-04-27) que trataba el
    // negativo como corrupción; hoy el negativo es dato. La atomicidad del
    // UPDATE único se conserva: dos ventas concurrentes siguen sin pisarse.
    const updateResult = await tx.$queryRaw<Array<{ id: string; currentStock: any; previousStock: any }>>`
      UPDATE "Inventory"
      SET "currentStock" = "currentStock" - ${new Decimal(quantity)},
          "updatedAt" = NOW()
      WHERE "productId" = ${productId}
      RETURNING id, "currentStock", ("currentStock" + ${new Decimal(quantity)}) AS "previousStock"
    `

    if (updateResult.length === 0) {
      // Sin condición de stock, cero filas sólo significa una cosa: el
      // producto no tiene fila de Inventory. Eso sigue siendo error de
      // configuración, no de existencias.
      throw new AppError(
        `No inventory record for product "${product.name}". Create inventory via Product Wizard or manual stock adjustment.`,
        404,
      )
    }

    const inventoryId = updateResult[0].id
    const newStock = new Decimal(updateResult[0].currentStock)
    const previousStock = new Decimal(updateResult[0].previousStock)
    // Synthetic shape to keep downstream code happy
    const inventory = { id: inventoryId } as { id: string }

    await tx.inventoryMovement.create({
      data: {
        inventoryId: inventory.id,
        type: MovementType.SALE,
        quantity: new Decimal(-quantity),
        previousStock,
        newStock,
        reason: `Sold ${quantity}x ${product.name}`,
        reference: orderId,
        createdBy: staffId,
        // Liga al posting durable (fase 2) — null en los callers legacy.
        postingLineId: postingLineId ?? null,
      },
    })

    return {
      inventoryMethod: 'QUANTITY',
      inventoryId: inventory.id,
      quantityDeducted: quantity,
      remainingStock: newStock.toNumber(),
      previousStock: previousStock.toNumber(),
      productName: product.name,
      message: `Deducted ${quantity} unit(s) from inventory tracking`,
    }
  })

  // Cruzar a negativo es la ANOMALÍA que el dueño audita — se registra fuera
  // de la transacción (logAction es fire-and-forget y jamás puede tumbar ni
  // retrasar un cobro ya aprobado). El InventoryMovement de adentro ya guarda
  // el detalle; esto lo hace visible en la bitácora del dueño (regla
  // dual-write de ActivityLog).
  if (result.remainingStock < 0) {
    logger.warn('⚠️ [Inventario] La venta dejó el stock en NEGATIVO — señal de descuadre, la venta NO se bloquea', {
      venueId,
      productId,
      productName: result.productName,
      orderId,
      previousStock: result.previousStock,
      newStock: result.remainingStock,
      quantitySold: quantity,
    })
    void logAction({
      staffId: staffId ?? null,
      venueId,
      action: 'STOCK_WENT_NEGATIVE',
      entity: 'Inventory',
      entityId: productId,
      data: {
        productName: result.productName,
        orderId,
        previousStock: result.previousStock,
        newStock: result.remainingStock,
        quantitySold: quantity,
      },
    })
  }

  return result
}

/**
 * Deduct recipe-based inventory (for restaurants)
 * Deducts all ingredients used in the recipe
 *
 * ✅ WORLD-CLASS: Passes modifiers to support SUBSTITUTION mode
 * Variable ingredients in recipes can be substituted by modifier selections
 */
async function deductRecipeBasedInventory(
  venueId: string,
  productId: string,
  quantity: number,
  orderId: string,
  staffId?: string,
  orderModifiers?: OrderModifierForInventory[],
  postingLineId?: string,
) {
  // Use existing recipe deduction logic with modifier support
  await deductStockForRecipe(venueId, productId, quantity, orderId, staffId, orderModifiers, postingLineId)

  return {
    inventoryMethod: 'RECIPE',
    message: `Deducted ingredients for ${quantity} portion(s) based on recipe`,
  }
}

/**
 * Get inventory status for a product
 * Returns different information based on inventory method
 */
export async function getProductInventoryStatus(venueId: string, productId: string) {
  const inventoryMethod = await getProductInventoryMethod(productId)

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: {
      recipe: {
        include: {
          lines: {
            include: {
              rawMaterial: {
                select: {
                  id: true,
                  name: true,
                  currentStock: true,
                  reorderPoint: true,
                  unit: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  // No inventory tracking
  if (!inventoryMethod) {
    return {
      inventoryMethod: null,
      available: true,
      message: 'No inventory tracking',
    }
  }

  switch (inventoryMethod) {
    case 'QUANTITY': {
      // ✅ FIX: QUANTITY method should use Inventory table (per productWizard.service.ts design)
      // First, check the Inventory table (primary source for QUANTITY products)
      const inventoryRecord = await prisma.inventory.findUnique({
        where: { productId },
      })

      if (inventoryRecord) {
        const currentStock = inventoryRecord.currentStock.toNumber()
        const minimumStock = inventoryRecord.minimumStock.toNumber()
        return {
          inventoryMethod: 'QUANTITY',
          available: currentStock > 0,
          currentStock,
          reorderPoint: minimumStock,
          lowStock: currentStock <= minimumStock,
          message: `${currentStock} unit(s) in stock`,
        }
      }

      // Fallback: Check RawMaterial (legacy or externalData.rawMaterialId linkage)
      const externalData = product.externalData as any
      let rawMaterial = null

      if (externalData?.rawMaterialId) {
        rawMaterial = await prisma.rawMaterial.findUnique({
          where: { id: externalData.rawMaterialId },
        })
      }

      // Fallback: search by conventional SKU pattern
      if (!rawMaterial) {
        rawMaterial = await prisma.rawMaterial.findFirst({
          where: {
            venueId,
            sku: `PRODUCT-${productId}`,
          },
        })
      }

      return {
        inventoryMethod: 'QUANTITY',
        available: rawMaterial ? rawMaterial.currentStock.greaterThan(0) : false,
        currentStock: rawMaterial?.currentStock.toNumber() || 0,
        reorderPoint: rawMaterial?.reorderPoint.toNumber() || 0,
        lowStock: rawMaterial ? rawMaterial.currentStock.lessThanOrEqualTo(rawMaterial.reorderPoint) : false,
        message: rawMaterial ? `${rawMaterial.currentStock.toNumber()} unit(s) in stock` : 'Not tracked in inventory',
      }
    }

    case 'RECIPE': {
      if (!product.recipe) {
        return {
          inventoryMethod: 'RECIPE',
          available: true,
          message: 'Recipe not configured yet',
        }
      }

      // Calculate yield per ingredient and identify bottleneck
      const ingredientYields = product.recipe.lines
        .filter(line => !line.isOptional) // Skip optional ingredients for bottleneck calculation
        .map(line => {
          const available = line.rawMaterial.currentStock
          const required = line.quantity
          // Avoid division by zero
          if (required.equals(0)) return { line, portions: Infinity, available, required }

          const portions = available.div(required).toNumber()
          return {
            line,
            portions: Math.floor(portions),
            available: available.toNumber(),
            required: required.toNumber(),
          }
        })
        .sort((a, b) => a.portions - b.portions)

      const bottleneck = ingredientYields[0]

      // If no mandatory ingredients, assume infinite capacity (or handling logic)
      // But typically we treat "no ingredients" as "0 capacity" or "Not configured"
      let maxPortions = bottleneck ? bottleneck.portions : 0

      // If we have no mandatory ingredients but have recipe, strictly speaking yield is undefined/0
      if (product.recipe.lines.length === 0) maxPortions = 0

      // Map existing insufficientIngredients (legacy support + specific "completely missing" list)
      const insufficientIngredients = product.recipe.lines
        .filter(line => !line.isOptional && line.rawMaterial.currentStock.lessThan(line.quantity))
        .map(line => ({
          rawMaterialId: line.rawMaterial.id,
          name: line.rawMaterial.name,
          required: line.quantity.toNumber(),
          available: line.rawMaterial.currentStock.toNumber(),
          unit: line.rawMaterial.unit,
        }))

      return {
        inventoryMethod: 'RECIPE',
        available: maxPortions > 0,
        maxPortions,
        insufficientIngredients,
        // ✅ NEW: Explicit Limiting Factor (Bottleneck)
        limitingIngredient: bottleneck
          ? {
              rawMaterialId: bottleneck.line.rawMaterial.id,
              name: bottleneck.line.rawMaterial.name,
              required: bottleneck.required,
              available: bottleneck.available,
              unit: bottleneck.line.rawMaterial.unit,
              maxPortions: bottleneck.portions, // How many this ingredient allows
            }
          : null,
        recipeCost: product.recipe.totalCost.toNumber(),
        message: bottleneck ? `Limited by ${bottleneck.line.rawMaterial.name} (${bottleneck.portions})` : 'Recipe needs ingredients',
      }
    }

    default:
      throw new AppError(`Unknown inventory type: ${inventoryMethod}`, 500)
  }
}

/**
 * Wizard step 1: Check if product should use inventory
 * Returns recommendation based on venue type and features
 */
export async function shouldProductUseInventory(venueId: string) {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    include: {
      features: {
        where: {
          feature: {
            code: 'INVENTORY_TRACKING',
          },
        },
        select: {
          active: true,
        },
      },
    },
  })

  if (!venue) {
    throw new AppError('Venue not found', 404)
  }

  const hasInventoryFeature = venue.features.some(f => f.active)

  return {
    hasInventoryFeature,
    recommendation: hasInventoryFeature ? 'wizard.step2.recommendationEnabled' : 'wizard.step2.recommendationDisabled',
    options: [
      {
        type: 'NONE' as const,
        label: 'wizard.step2.noInventory',
        description: 'wizard.step2.noInventoryDesc',
        enabled: true,
      },
      {
        type: 'QUANTITY' as const,
        label: 'wizard.step2.simpleStock',
        description: 'wizard.step2.simpleStockDesc',
        enabled: hasInventoryFeature,
      },
      {
        type: 'RECIPE' as const,
        label: 'wizard.step2.recipeBased',
        description: 'wizard.step2.recipeBasedDesc',
        enabled: hasInventoryFeature,
      },
    ],
  }
}

/**
 * Set inventory method for a product
 * ✅ WORLD-CLASS: Updates dedicated column (not JSON!)
 */
export async function setProductInventoryMethod(productId: string, inventoryMethod: InventoryMethod) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  // ✅ Write to dedicated column (world-class pattern)
  await prisma.product.update({
    where: { id: productId },
    data: {
      trackInventory: true, // Enable tracking
      inventoryMethod, // Set method (QUANTITY | RECIPE)
    },
  })

  logAction({
    venueId: product.venueId,
    action: 'PRODUCT_INVENTORY_METHOD_SET',
    entity: 'Product',
    entityId: productId,
    data: { inventoryMethod },
  })

  return {
    success: true,
    inventoryMethod,
    message: `Product inventory method set to ${inventoryMethod}`,
  }
}
