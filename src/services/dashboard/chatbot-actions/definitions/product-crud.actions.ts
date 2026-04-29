import prisma from '@/utils/prismaClient'
import { ActionDefinition } from '../types'
import * as productService from '../../product.dashboard.service'
import * as productWizard from '../../productWizard.service'

export const productCrudActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // menu.product.create
  // ---------------------------------------------------------------------------
  {
    actionType: 'menu.product.create',
    entity: 'Product',
    operation: 'create',
    permission: 'menu:create',
    dangerLevel: 'low',
    service: 'productService',
    method: 'createProduct',
    description: 'Crea un nuevo producto en el menú del venue',
    examples: [
      'Agrega un nuevo producto: Hamburguesa Clásica, precio $120, categoría Hamburguesas',
      'Crear producto Pizza Margarita, $95 pesos, tipo FOOD_AND_BEV, SKU PIZ001',
      'nuevo producto Agua Mineral 600ml, $25, sku AGU600',
      'add producto Ensalada César, $85, categoría Ensaladas, es tipo comida',
      'crear café americano al menú, precio 45 pesos, sku CAF001',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el nombre del producto?',
      },
      price: {
        type: 'decimal',
        required: true,
        prompt: '¿Cuál es el precio del producto?',
        min: 0.01,
      },
      sku: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el SKU o código del producto?',
        transform: 'uppercase',
        unique: true,
      },
      gtin: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el GTIN/código de barras del producto? Si no tiene, puedo continuar sin GTIN.',
        unique: true,
      },
      type: {
        type: 'enum',
        required: false,
        prompt: '¿Cuál es el tipo de producto?',
        options: ['REGULAR', 'FOOD_AND_BEV', 'APPOINTMENTS_SERVICE', 'CLASS', 'EVENT', 'DIGITAL', 'DONATION', 'SERVICE', 'OTHER'],
        default: 'FOOD_AND_BEV',
      },
      categoryId: {
        type: 'string',
        required: true,
        prompt: '¿A qué categoría pertenece el producto?',
      },
      trackInventory: {
        type: 'boolean',
        required: false,
        prompt: '¿Quieres seguimiento de inventario para este producto?',
        default: false,
      },
      inventoryMethod: {
        type: 'enum',
        required: false,
        prompt: '¿Cómo quieres rastrear el inventario? QUANTITY = conteo directo, RECIPE = por ingredientes/receta',
        options: ['QUANTITY', 'RECIPE'],
      },
      initialStock: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuántas unidades tienes en stock inicial?',
        min: 0,
      },
      costPerUnit: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es el costo unitario del producto?',
        min: 0,
      },
      description: {
        type: 'string',
        required: false,
        prompt: '¿Tienes alguna descripción para el producto?',
      },
    },
    serviceAdapter: async (params, context) => {
      const { name, price, sku, gtin, type, categoryId, description, trackInventory, inventoryMethod, initialStock, costPerUnit } =
        params as any

      // Resolve categoryId by name
      let resolvedCategoryId = categoryId as string | undefined
      if (categoryId && typeof categoryId === 'string' && categoryId.length < 20) {
        const category = await prisma.menuCategory.findFirst({
          where: { venueId: context.venueId, name: { contains: categoryId, mode: 'insensitive' }, active: true },
          select: { id: true },
        })
        resolvedCategoryId = category?.id
      }
      if (!resolvedCategoryId) throw new Error('No encontré esa categoría. Indica una categoría activa del menú.')

      // Auto-generate SKU if not provided
      const finalSku = (sku as string) || name.toString().toUpperCase().replace(/\s+/g, '-').substring(0, 20)

      // Step 1: Create the product
      const product = await productService.createProduct(context.venueId, {
        name: name as string,
        price: Number(price),
        sku: finalSku,
        gtin: gtin as string | undefined,
        type: (type as any) || 'FOOD_AND_BEV',
        categoryId: resolvedCategoryId,
        description: description as string | undefined,
      })

      const productId = (product as any).id

      // Step 2: If inventory tracking requested, configure it
      const useInventory = Boolean(trackInventory) || inventoryMethod === 'QUANTITY' || inventoryMethod === 'RECIPE'
      const method = inventoryMethod || (useInventory ? 'QUANTITY' : undefined)

      if (useInventory && method && productId) {
        try {
          // Configure inventory tracking on the product
          await productWizard.configureInventoryStep2(productId, {
            useInventory: true,
            inventoryMethod: method as 'QUANTITY' | 'RECIPE',
          })

          // Step 3: If QUANTITY, setup initial stock
          if (method === 'QUANTITY') {
            await productWizard.setupSimpleStockStep3(context.venueId, productId, {
              initialStock: Number(initialStock ?? 0),
              reorderPoint: 5,
              costPerUnit: Number(costPerUnit ?? price ?? 0),
            })
          }
          // For RECIPE, user creates the recipe separately via "crea la receta de..."
        } catch {
          // Don't fail the whole creation if inventory setup fails
          // Product is created, inventory can be configured later
        }
      }

      return product
    },
    previewTemplate: {
      title: 'Crear producto: {{name}}',
      summary: 'Se creará el producto "{{name}}" a ${{price}} en la categoría "{{categoryId}}". SKU: {{sku}}. GTIN: {{gtin}}.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // menu.product.update
  // ---------------------------------------------------------------------------
  {
    actionType: 'menu.product.update',
    entity: 'Product',
    operation: 'update',
    permission: 'menu:update',
    dangerLevel: 'medium',
    service: 'productService',
    method: 'updateProduct',
    description:
      'Actualiza datos del PRODUCTO en el menú: precio, nombre, disponibilidad, SKU, categoría. NO para recetas ni ingredientes — para eso usa inventory--recipe--update o inventory--recipe--addLine.',
    examples: [
      'Cambia el precio de la Hamburguesa Clásica a $135',
      'Actualiza la descripción de la Pizza Margarita',
      'desactiva el producto Ensalada César temporalmente',
      'cambia el nombre del café americano a "Americano Clásico"',
      'update precio agua mineral a $30, está agotada activa=false',
    ],
    fields: {
      name: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el nuevo nombre del producto?',
      },
      price: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es el nuevo precio del producto?',
        min: 0,
      },
      description: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es la nueva descripción del producto?',
      },
      active: {
        type: 'boolean',
        required: false,
        prompt: '¿El producto está disponible en el menú?',
      },
      categoryId: {
        type: 'reference',
        required: false,
        prompt: '¿A qué categoría pertenece ahora el producto?',
        referenceEntity: 'Category',
      },
      kitchenName: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el nuevo nombre corto para la cocina?',
        max: 50,
      },
      abbreviation: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es la nueva abreviación para el TPV?',
        max: 24,
      },
      isAlcoholic: {
        type: 'boolean',
        required: false,
        prompt: '¿El producto contiene alcohol?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId, name, price, description, active, categoryId, kitchenName, abbreviation, isAlcoholic } = params as any

      // Resolve categoryId by name if it looks like a name (not a cuid)
      let resolvedCategoryId = categoryId as string | undefined
      if (categoryId && typeof categoryId === 'string' && categoryId.length < 20) {
        const category = await prisma.menuCategory.findFirst({
          where: { venueId: context.venueId, name: { contains: categoryId, mode: 'insensitive' }, active: true },
          select: { id: true },
        })
        resolvedCategoryId = category?.id
      }

      return productService.updateProduct(context.venueId, entityId as string, {
        name: name as string | undefined,
        price: price !== undefined ? Number(price) : undefined,
        description: description as string | undefined,
        active: active !== undefined ? Boolean(active) : undefined,
        categoryId: resolvedCategoryId,
        kitchenName: kitchenName as string | undefined,
        abbreviation: abbreviation as string | undefined,
        isAlcoholic: isAlcoholic !== undefined ? Boolean(isAlcoholic) : undefined,
      })
    },
    previewTemplate: {
      title: 'Actualizar producto: {{name}}',
      summary: 'Se actualizarán los campos del producto "{{name}}".',
      showDiff: true,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // menu.product.delete
  // ---------------------------------------------------------------------------
  {
    actionType: 'menu.product.delete',
    entity: 'Product',
    operation: 'delete',
    permission: 'menu:delete',
    dangerLevel: 'high',
    service: 'productService',
    method: 'deleteProduct',
    description: 'Elimina (soft delete) un producto del menú. Se conserva el historial de ventas.',
    examples: [
      'Elimina el producto Hamburguesa Clásica del menú',
      'Borra la Pizza Margarita, ya no la venderemos',
      'elimina el agua mineral del menú',
      'quitar del menú el producto Ensalada César',
      'delete café americano del sistema',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál producto quieres eliminar?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId } = params as any
      // deleteProduct requires userId (not optional) — passed from context
      return productService.deleteProduct(context.venueId, entityId as string, context.userId)
    },
    previewTemplate: {
      title: 'Eliminar producto: {{name}}',
      summary:
        'Se eliminará el producto "{{name}}" del menú. El historial de ventas se conservará. Esta acción no se puede deshacer fácilmente.',
      showDiff: false,
      showImpact: true,
    },
  },
]
