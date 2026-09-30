import prisma from '../../utils/prismaClient'
import { Decimal } from '@prisma/client/runtime/library'
import { Prisma, Unit } from '@prisma/client'
import AppError from '../../errors/AppError'
import { createRecipe } from './recipe.service'
import { setProductInventoryMethod, InventoryMethod } from './productInventoryIntegration.service'
import { ensureQuantityInventoryRow } from './quantityInventoryRow'
import logger from '@/config/logger'
import { logAction } from './activity-log.service'
import type { CatalogActor } from '../../types/master-catalog'
import {
  assertLegacyCatalogGovernanceForVenue,
  assertLegacyProductReferencesForVenue,
  writeLegacyServiceProductCreationAuditForVenue,
} from '../master-catalog/catalogGovernance.service'

/**
 * Product Creation Wizard Service
 * Guides users through creating products with optional inventory integration
 */

export interface WizardStep1Data {
  // Basic product info
  name: string
  description?: string
  price: number
  categoryId: string
  imageUrl?: string
  // Inventory codes (optional; SKU auto-generated if empty)
  sku?: string
  gtin?: string
  // Product type (defaults to FOOD if omitted)
  type?: string
  // Service-specific (SERVICE, APPOINTMENTS_SERVICE)
  duration?: number
  // Class-specific (CLASS)
  maxParticipants?: number
  layoutConfig?: Record<string, unknown> | null
  // Estación de impresión (ruteo de comandas)
  printStationId?: string | null
}

export interface WizardStep2Data {
  // Inventory decision
  useInventory: boolean
  inventoryMethod?: InventoryMethod // 'QUANTITY' | 'RECIPE'
}

export interface WizardStep3SimpleStockData {
  // For SIMPLE_STOCK: initial stock setup
  initialStock: number
  reorderPoint: number
  costPerUnit: number
}

export interface WizardStep3RecipeData {
  // For RECIPE_BASED: recipe configuration
  portionYield: number
  prepTime?: number
  cookTime?: number
  notes?: string
  ingredients: Array<{
    rawMaterialId: string
    quantity: number
    unit: string
    isOptional?: boolean
    substituteNotes?: string
  }>
}

/**
 * Step 1: Create basic product
 * Returns productId for subsequent steps
 */
export async function createProductStep1(venueId: string, data: WizardStep1Data, actor: CatalogActor) {
  // Validate category belongs to venue
  const category = await prisma.menuCategory.findFirst({
    where: {
      id: data.categoryId,
      venueId,
    },
  })

  if (!category) {
    throw new AppError('Category not found or does not belong to this venue', 404)
  }

  // SKU: use provided value if non-empty, otherwise auto-generate.
  // GTIN: optional; pass through if provided, omit (NULL) otherwise.
  const providedSku = data.sku?.trim()
  const providedGtin = data.gtin?.trim()

  // Create product. Handle unique-constraint collisions (P2002) with a
  // user-friendly Spanish message identifying WHICH column collided, so the
  // frontend toast can tell the user exactly which code to change instead of
  // showing a generic 500.
  let product
  try {
    product = await prisma.$transaction(async tx => {
      await assertLegacyCatalogGovernanceForVenue(tx, { venueId, operation: 'CREATE', willBeVendable: true, actor })
      await assertLegacyProductReferencesForVenue(tx, {
        venueId,
        categoryId: data.categoryId,
        printStationId: data.printStationId,
      })
      const created = await tx.product.create({
        data: {
          venueId,
          createdById: actor.type === 'HUMAN' ? actor.staffId : null,
          categoryId: data.categoryId,
          printStationId: data.printStationId ?? null,
          name: data.name,
          sku: providedSku && providedSku.length > 0 ? providedSku : `SKU-${Date.now()}`,
          gtin: providedGtin && providedGtin.length > 0 ? providedGtin : undefined,
          description: data.description,
          price: new Decimal(data.price),
          imageUrl: data.imageUrl && data.imageUrl.trim() !== '' ? data.imageUrl : undefined,
          active: true,
          ...(data.type && { type: data.type as any }),
          ...(data.duration && { duration: data.duration }),
          ...(data.maxParticipants && { maxParticipants: data.maxParticipants }),
          ...(data.layoutConfig !== undefined && {
            layoutConfig: data.layoutConfig ? (data.layoutConfig as Prisma.InputJsonValue) : Prisma.JsonNull,
          }),
          externalData: {
            wizardCompleted: false,
            inventoryConfigured: false,
          },
        },
      })
      if (actor.type === 'SERVICE') {
        await writeLegacyServiceProductCreationAuditForVenue(tx, { venueId, productId: created.id, actor })
      }
      return created
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta?.target as string[] | string | undefined) ?? ''
      const isSkuConflict = Array.isArray(target) ? target.includes('sku') : String(target).includes('sku')
      const isGtinConflict = Array.isArray(target) ? target.includes('gtin') : String(target).includes('gtin')
      if (isSkuConflict) {
        throw new AppError(
          `El SKU "${providedSku}" ya está en uso por otro producto en esta sucursal. Usa un código distinto o déjalo vacío para auto-generar.`,
          409,
        )
      }
      if (isGtinConflict) {
        throw new AppError(`El GTIN "${providedGtin}" ya está asignado a otro producto en esta sucursal.`, 409)
      }
      throw new AppError('Ya existe un producto con esos datos en esta sucursal.', 409)
    }
    throw error
  }

  return {
    success: true,
    productId: product.id,
    product: {
      id: product.id,
      name: product.name,
      price: product.price.toNumber(),
      category: category.name,
    },
    nextStep: 'inventory_decision',
    message: 'Product created successfully. Configure inventory next.',
  }
}

/**
 * Step 2: Configure inventory type
 * User decides if and how to track inventory
 */
export async function configureInventoryStep2(venueId: string, productId: string, data: WizardStep2Data) {
  // 🔴 Por negocio: el permiso se autorizó en `venueId`; un producto de otro negocio no existe.
  const product = await prisma.product.findUnique({
    where: { id: productId, venueId },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  if (!data.useInventory || !data.inventoryMethod) {
    // User doesn't want inventory tracking
    await prisma.product.update({
      where: { id: productId },
      data: {
        trackInventory: false,
        inventoryMethod: null,
        externalData: {
          ...(product.externalData as any),
          wizardCompleted: true,
          inventoryConfigured: true,
        },
      },
    })

    return {
      success: true,
      inventoryMethod: null,
      nextStep: 'complete',
      message: 'Product created without inventory tracking',
    }
  }

  if (!data.inventoryMethod) {
    throw new AppError('Inventory method is required when useInventory is true', 400)
  }

  // Set inventory method (✅ WORLD-CLASS: Uses dedicated column)
  await setProductInventoryMethod(venueId, productId, data.inventoryMethod)

  await prisma.product.update({
    where: { id: productId },
    data: {
      externalData: {
        ...(product.externalData as any),
        inventoryConfigured: true,
      },
    },
  })

  return {
    success: true,
    inventoryMethod: data.inventoryMethod,
    nextStep: data.inventoryMethod === 'QUANTITY' ? 'simple_stock_setup' : 'recipe_setup',
    message: `Inventory method set to ${data.inventoryMethod}`,
  }
}

/**
 * Step 3A: Setup simple stock (for retail/jewelry)
 * Creates/updates the product's raw material record
 */
export async function setupSimpleStockStep3(venueId: string, productId: string, data: WizardStep3SimpleStockData) {
  // 🔴 Todo cambio de saldo deja movimiento (audit Codex xhigh 2026-08-14). Antes
  // este paso escribía `currentStock` a secas —incluso PISANDO un inventario que
  // ya tenía saldo— sin `InventoryMovement`: el kardex nacía roto y la
  // reconciliación (`saldo == apertura + Σ deltas`) era imposible de cumplir.
  // Ése era el origen REAL del descuadre medido, no las ventas.
  //
  // 🔴 Y TODO el paso va en UNA transacción (auditorías de Codex, 29-sep): el cambio de receta a cantidad,
  // el producto, el saldo leído BAJO CANDADO de la fila, el kardex y el costo. Leído afuera, una venta en
  // medio dejaba saldo ≠ Σ movimientos; y un fallo al anotar el movimiento dejaba el saldo cambiado sin
  // kardex, o la receta ya borrada. La venta (`deductSimpleStock`) toma el mismo candado de la fila.
  const nuevoSaldo = new Decimal(data.initialStock)
  await prisma.$transaction(async tx => {
    // 🔴 Por negocio: sin esto se creaba un Inventory de ESTE negocio para el producto de otro.
    const product = await tx.product.findUnique({
      where: { id: productId, venueId },
      select: { externalData: true, recipe: { select: { id: true } } },
    })
    if (!product) throw new AppError('Product not found', 404)

    // ✅ Auto-switch de RECETA a CANTIDAD en vez de un 409.
    if (product.recipe) {
      logger.info('🔄 Auto-switching from RECIPE to QUANTITY - cleaning up existing recipe')
      await switchInventoryMethod(venueId, productId, 'QUANTITY', tx)
    }

    // El producto PRIMERO (toma su candado de fila, como los demás escritores de la configuración) y
    // queda «por cantidad» de verdad: antes sólo lo decía la respuesta, y un producto RECETA sin receta, o
    // sin inventario, recibía un saldo que la venta ignoraba.
    await tx.product.update({
      where: { id: productId },
      data: {
        trackInventory: true,
        inventoryMethod: 'QUANTITY',
        cost: new Decimal(data.costPerUnit), // ✅ Save cost per unit
        externalData: {
          ...(product.externalData as any),
          wizardCompleted: true,
          inventoryConfigured: true,
        },
      },
    })

    // La fila tiene que existir para poder tomar su candado; una existente no se toca.
    await tx.inventory.createMany({ data: [{ productId, venueId, currentStock: 0, minimumStock: 0 }], skipDuplicates: true })
    const [fila] = await tx.$queryRaw<Array<{ id: string; currentStock: Prisma.Decimal }>>`
      SELECT id, "currentStock" FROM "Inventory" WHERE "productId" = ${productId} FOR UPDATE`
    const saldoPrevio = new Decimal(fila.currentStock)
    const delta = nuevoSaldo.minus(saldoPrevio)
    // Una fila en 0 y sin kardex (la deja el paso 2 o nace aquí) recibe el PRIMER saldo, no un ajuste.
    const esSaldoInicial =
      saldoPrevio.isZero() && !(await tx.inventoryMovement.findFirst({ where: { inventoryId: fila.id }, select: { id: true } }))

    await tx.inventory.update({
      where: { id: fila.id },
      data: {
        currentStock: nuevoSaldo,
        minimumStock: new Decimal(data.reorderPoint),
      },
    })

    // Sin cambio de saldo no se inventa un movimiento de cero (sería ruido en el
    // kardex); re-correr el asistente con el mismo número no ensucia el historial.
    if (!delta.isZero()) {
      await tx.inventoryMovement.create({
        data: {
          inventoryId: fila.id,
          type: 'ADJUSTMENT',
          quantity: delta,
          previousStock: saldoPrevio,
          newStock: nuevoSaldo,
          reason: esSaldoInicial ? 'Saldo inicial (asistente de producto)' : 'Ajuste de existencias (asistente de producto)',
        },
      })
    }
  })

  return {
    success: true,
    inventoryMethod: 'QUANTITY',
    initialStock: data.initialStock,
    minimumStock: data.reorderPoint,
    nextStep: 'complete',
    message: `Simple stock tracking configured: ${data.initialStock} unit(s) in stock`,
  }
}

/**
 * Step 3B: Setup recipe (for restaurants)
 * Creates recipe with ingredients
 */
export async function setupRecipeStep3(venueId: string, productId: string, data: WizardStep3RecipeData) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  if (product.venueId !== venueId) {
    throw new AppError('Product does not belong to this venue', 403)
  }

  // ✅ WORLD-CLASS: Auto-switch from QUANTITY to RECIPE if needed
  // Instead of blocking with 409 error, intelligently clean up conflicting config
  const existingQuantityStock = await prisma.rawMaterial.findFirst({
    where: {
      venueId,
      sku: `PRODUCT-${productId}`,
    },
  })

  if (existingQuantityStock) {
    logger.info('🔄 Auto-switching from QUANTITY to RECIPE - cleaning up existing quantity tracking')
    await switchInventoryMethod(venueId, productId, 'RECIPE')
  }

  // Validate that all ingredients exist
  const rawMaterialIds = data.ingredients.map(i => i.rawMaterialId)
  const rawMaterials = await prisma.rawMaterial.findMany({
    where: {
      id: { in: rawMaterialIds },
      venueId,
    },
  })

  if (rawMaterials.length !== rawMaterialIds.length) {
    throw new AppError('Some ingredients were not found or do not belong to this venue', 404)
  }

  // Create recipe
  const recipe = await createRecipe(venueId, productId, {
    portionYield: data.portionYield,
    prepTime: data.prepTime,
    cookTime: data.cookTime,
    notes: data.notes,
    lines: data.ingredients.map(ing => ({
      rawMaterialId: ing.rawMaterialId,
      quantity: ing.quantity,
      unit: ing.unit as Unit,
      isOptional: ing.isOptional || false,
      substituteNotes: ing.substituteNotes,
    })),
  })

  // Mark wizard as complete
  await prisma.product.update({
    where: { id: productId },
    data: {
      externalData: {
        ...(product.externalData as any),
        wizardCompleted: true,
        inventoryConfigured: true,
      },
    },
  })

  return {
    success: true,
    inventoryMethod: 'RECIPE',
    recipeId: recipe.id,
    recipeCost: recipe.totalCost.toNumber(),
    portionYield: data.portionYield,
    ingredientCount: data.ingredients.length,
    nextStep: 'complete',
    message: `Recipe configured with ${data.ingredients.length} ingredient(s)`,
  }
}

/**
 * Complete wizard flow - all in one call
 * For simpler UIs that don't need step-by-step
 */
export async function createProductWithInventory(
  venueId: string,
  data: {
    product: WizardStep1Data
    inventory: WizardStep2Data
    simpleStock?: WizardStep3SimpleStockData
    recipe?: WizardStep3RecipeData
  },
  actor: CatalogActor,
) {
  // Step 1: Create product
  const step1Result = await createProductStep1(venueId, data.product, actor)
  const productId = step1Result.productId

  try {
    // Step 2: Configure inventory
    const step2Result = await configureInventoryStep2(venueId, productId, data.inventory)

    // Step 3: Setup inventory details
    let step3Result
    if (step2Result.inventoryMethod === 'QUANTITY' && data.simpleStock) {
      step3Result = await setupSimpleStockStep3(venueId, productId, data.simpleStock)
    } else if (step2Result.inventoryMethod === 'RECIPE' && data.recipe) {
      step3Result = await setupRecipeStep3(venueId, productId, data.recipe)
    }

    logAction({
      venueId,
      action: 'PRODUCT_CREATED',
      entity: 'Product',
      entityId: productId,
      data: { name: data.product.name, inventoryMethod: step2Result.inventoryMethod },
    })

    return {
      success: true,
      productId,
      inventoryMethod: step2Result.inventoryMethod,
      details: step3Result,
      message: 'Product created successfully with inventory configuration',
    }
  } catch (error) {
    // Rollback: Delete the product if inventory setup fails
    await prisma.product.delete({
      where: { id: productId },
    })
    throw error
  }
}

/**
 * Get wizard progress for a product
 * Returns current step and what's completed
 */
export async function getWizardProgress(venueId: string, productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId, venueId },
    include: {
      recipe: {
        select: {
          id: true,
          totalCost: true,
          lines: {
            select: {
              rawMaterialId: true,
            },
          },
        },
      },
    },
  })

  if (!product) {
    throw new AppError('Product not found', 404)
  }

  const externalData = (product.externalData as any) || {}
  const wizardCompleted = externalData.wizardCompleted || false
  const inventoryConfigured = externalData.inventoryConfigured || false
  const inventoryMethod = product.inventoryMethod // ✅ WORLD-CLASS: Read from dedicated column

  // ✅ WORLD-CLASS: Check if quantity tracking inventory exists (Inventory table, not RawMaterial)
  const inventoryRecord = await prisma.inventory.findUnique({
    where: {
      productId,
    },
  })

  return {
    productId: product.id,
    productName: product.name,
    wizardCompleted,
    steps: {
      productCreated: true,
      inventoryDecided: !!product.inventoryMethod,
      inventoryConfigured,
    },
    inventoryMethod,
    details:
      inventoryMethod === 'QUANTITY' && inventoryRecord
        ? {
            currentStock: inventoryRecord.currentStock.toNumber(),
            minimumStock: inventoryRecord.minimumStock.toNumber(),
            reservedStock: inventoryRecord.reservedStock.toNumber(),
            costPerUnit: product.cost?.toNumber() || 0, // ✅ Include cost per unit
          }
        : inventoryMethod === 'RECIPE' && product.recipe
          ? {
              recipeId: product.recipe.id,
              recipeCost: product.recipe.totalCost.toNumber(),
              ingredientCount: product.recipe.lines.length,
            }
          : null,
    nextStep: !product.inventoryMethod
      ? 'inventory_decision'
      : !inventoryConfigured
        ? inventoryMethod === 'QUANTITY'
          ? 'simple_stock_setup'
          : 'recipe_setup'
        : 'complete',
  }
}

/**
 * Switch inventory method (auto-conversion)
 * Handles conversion between QUANTITY ↔ RECIPE
 * Automatically removes old configuration and updates inventoryMethod
 */
export async function switchInventoryMethod(
  venueId: string,
  productId: string,
  newMethod: InventoryMethod,
  db?: Prisma.TransactionClient,
): Promise<{ success: true; newMethod: InventoryMethod; message: string }> {
  // Con `db`, dentro de la transacción del llamador (el paso 3 del asistente): si algo falla después,
  // la receta sigue ahí.
  if (!db) return prisma.$transaction(tx => switchInventoryMethod(venueId, productId, newMethod, tx))

  const product = await db.product.findUnique({ where: { id: productId }, select: { venueId: true } })
  if (!product) {
    throw new AppError('Product not found', 404)
  }
  if (product.venueId !== venueId) {
    throw new AppError('Product does not belong to this venue', 403)
  }

  // 🔴 El producto PRIMERO (toma su candado de fila) y DESPUÉS se borra la configuración vieja por
  // `productId` (auditoría de Codex, 29-sep): otro cambio que escribe el mismo producto espera aquí o
  // ya terminó, y el borrado ve lo que dejó. Borrar el id leído antes dejaba colgando la fila de
  // inventario que otro cambio creó en medio, bajo un producto que ya la ignora. Y `deleteMany`: lo
  // que otro ya borró no es error (con `delete` tronaba P2025).
  const updated = await db.product.update({
    where: { id: productId },
    data: {
      inventoryMethod: newMethod,
    },
  })
  if (newMethod === 'RECIPE') {
    // Switching TO RECIPE: Remove existing quantity tracking (Inventory table)
    await db.inventory.deleteMany({ where: { productId } })
  } else if (newMethod === 'QUANTITY') {
    // Switching TO QUANTITY: Remove existing recipe (lines first: foreign key)
    await db.recipeLine.deleteMany({ where: { recipe: { productId } } })
    await db.recipe.deleteMany({ where: { productId } })
  }
  await ensureQuantityInventoryRow(db, updated)

  return {
    success: true,
    newMethod,
    message: `Inventory method switched to ${newMethod} successfully`,
  }
}
