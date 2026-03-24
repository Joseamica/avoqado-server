import prisma from '@/utils/prismaClient'
import { ActionDefinition } from '../types'
import * as recipeService from '../../recipe.service'

/**
 * Resolve ingredient names to rawMaterialIds via fuzzy match
 */
async function resolveRecipeLines(
  lines: Array<{ rawMaterialId?: string; name?: string; ingredientName?: string; quantity: number; unit: string; isOptional?: boolean }>,
  venueId: string,
): Promise<Array<{ rawMaterialId: string; quantity: number; unit: string; isOptional?: boolean }>> {
  const resolved: Array<{ rawMaterialId: string; quantity: number; unit: string; isOptional?: boolean }> = []

  for (const line of lines) {
    let rmId = line.rawMaterialId

    // If rawMaterialId looks like a name (not a cuid), resolve it
    if (!rmId || (rmId && rmId.length < 20)) {
      const searchName = rmId || line.ingredientName || line.name || ''
      if (!searchName) continue

      const match = await prisma.rawMaterial.findFirst({
        where: {
          venueId,
          active: true,
          deletedAt: null,
          name: { contains: searchName, mode: 'insensitive' },
        },
        select: { id: true },
      })

      if (match) {
        rmId = match.id
      } else {
        // Try fuzzy match
        const fuzzy = await prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "RawMaterial"
          WHERE "venueId" = ${venueId} AND "active" = true AND "deletedAt" IS NULL
            AND similarity(name, ${searchName}) > 0.2
          ORDER BY similarity(name, ${searchName}) DESC
          LIMIT 1
        `
        if (fuzzy.length > 0) {
          rmId = fuzzy[0].id
        } else {
          continue // Skip unresolvable ingredients
        }
      }
    }

    resolved.push({
      rawMaterialId: rmId!,
      quantity: Number(line.quantity),
      unit: line.unit,
      isOptional: line.isOptional ?? false,
    })
  }

  return resolved
}

export const recipeActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // inventory.recipe.create
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.recipe.create',
    entity: 'Recipe',
    operation: 'custom', // 'custom' instead of 'create' so entity resolution runs (needs to find the Product first)
    permission: 'menu:create',
    dangerLevel: 'low',
    service: 'recipeService',
    method: 'createRecipe',
    description:
      'Crea una RECETA para un producto del menú, especificando ingredientes y cantidades. Usa esta función cuando el usuario quiera definir los ingredientes de un platillo.',
    examples: [
      'Crea la receta del hamburguesa clásica: 200g carne, 1 pan, 10g lechuga',
      'Agrega receta para el café americano: 20g café molido, 200ml agua',
      'crear receta para pizza margarita con harina 200g, tomate 100g, queso 80g',
      'nueva receta para tacos de pollo, cada porción lleva 120g pollo y 2 tortillas',
      'receta para smoothie de mango: 150g mango, 100ml leche, 10g azúcar',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Para cuál producto quieres crear la receta?',
      },
      portionYield: {
        type: 'integer',
        required: true,
        prompt: '¿Cuántas porciones rinde esta receta?',
        min: 1,
        default: 1,
      },
      prepTime: {
        type: 'integer',
        required: false,
        prompt: '¿Cuántos minutos tarda la preparación?',
        min: 0,
      },
      cookTime: {
        type: 'integer',
        required: false,
        prompt: '¿Cuántos minutos tarda la cocción?',
        min: 0,
      },
      notes: {
        type: 'string',
        required: false,
        prompt: '¿Tienes alguna nota o instrucción especial para esta receta?',
      },
    },
    listField: {
      name: 'lines',
      description: 'Lista de ingredientes de la receta. Cada ingrediente debe tener nombre, cantidad y unidad.',
      minItems: 1,
      itemFields: {
        ingredientName: {
          type: 'string',
          required: true,
          prompt: '¿Cuál es el nombre del ingrediente?',
        },
        quantity: {
          type: 'decimal',
          required: true,
          prompt: '¿Qué cantidad se usa de este ingrediente por porción?',
          min: 0.001,
        },
        unit: {
          type: 'enum',
          required: true,
          prompt: '¿En qué unidad se mide este ingrediente?',
          options: [
            'GRAM',
            'KILOGRAM',
            'MILLIGRAM',
            'POUND',
            'OUNCE',
            'TON',
            'MILLILITER',
            'LITER',
            'GALLON',
            'QUART',
            'PINT',
            'CUP',
            'FLUID_OUNCE',
            'TABLESPOON',
            'TEASPOON',
            'UNIT',
            'PIECE',
            'DOZEN',
            'CASE',
            'BOX',
            'BAG',
            'BOTTLE',
            'CAN',
            'JAR',
          ],
        },
        isOptional: {
          type: 'boolean',
          required: false,
          prompt: '¿Este ingrediente es opcional?',
          default: false,
        },
        substituteNotes: {
          type: 'string',
          required: false,
          prompt: '¿Alguna nota sobre sustitutos para este ingrediente?',
        },
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
      resolveVia: {
        intermediateEntity: 'Product',
        intermediateField: 'name',
        linkField: 'productId',
      },
    },
    serviceAdapter: async (params, context) => {
      const { entityId, portionYield, prepTime, cookTime, notes, lines } = params as any

      // Resolve ingredient names to rawMaterialIds
      const resolvedLines = await resolveRecipeLines(lines || [], context.venueId)

      return recipeService.createRecipe(context.venueId, entityId as string, {
        portionYield: Number(portionYield || 1),
        prepTime: prepTime ? Number(prepTime) : undefined,
        cookTime: cookTime ? Number(cookTime) : undefined,
        notes,
        lines: resolvedLines as any,
      })
    },
    previewTemplate: {
      title: 'Crear receta para: {{name}}',
      summary: 'Se creará la receta rindiendo {{portionYield}} porción(es).',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.recipe.update
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.recipe.update',
    entity: 'Recipe',
    operation: 'update',
    permission: 'menu:update',
    dangerLevel: 'medium',
    service: 'recipeService',
    method: 'updateRecipe',
    description:
      'Actualiza la RECETA de un producto — usa esta función cuando el usuario mencione receta, ingredientes, porciones, rendimiento, tiempo de preparación o tiempo de cocción. NO para cambiar precio o nombre del producto.',
    examples: [
      'Actualiza la receta del hamburguesa, agrega 5g de sal',
      'Cambia el rendimiento de la pizza margarita a 2 porciones',
      'update receta café americano, prepTime ahora es 3 minutos',
      'modifica receta tacos de pollo, nuevas notas: "servir con cilantro"',
      'actualiza ingredientes smoothie mango, aumenta mango a 200g',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿De qué producto quieres actualizar la receta?',
      },
      portionYield: {
        type: 'integer',
        required: false,
        prompt: '¿Cuántas porciones rinde la receta actualizada?',
        min: 1,
      },
      prepTime: {
        type: 'integer',
        required: false,
        prompt: '¿Cuántos minutos tarda la preparación?',
        min: 0,
      },
      cookTime: {
        type: 'integer',
        required: false,
        prompt: '¿Cuántos minutos tarda la cocción?',
        min: 0,
      },
      notes: {
        type: 'string',
        required: false,
        prompt: '¿Cuáles son las nuevas notas de la receta?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
      resolveVia: {
        intermediateEntity: 'Product',
        intermediateField: 'name',
        linkField: 'productId',
      },
    },
    serviceAdapter: async (params, context) => {
      const { entityId, portionYield, prepTime, cookTime, notes } = params as any
      return recipeService.updateRecipe(context.venueId, entityId as string, {
        portionYield: portionYield ? Number(portionYield) : undefined,
        prepTime: prepTime ? Number(prepTime) : undefined,
        cookTime: cookTime ? Number(cookTime) : undefined,
        notes,
      })
    },
    previewTemplate: {
      title: 'Actualizar receta: {{name}}',
      summary: 'Se actualizarán los metadatos de la receta del producto "{{name}}".',
      showDiff: true,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.recipe.delete
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.recipe.delete',
    entity: 'Recipe',
    operation: 'delete',
    permission: 'menu:delete',
    dangerLevel: 'high',
    service: 'recipeService',
    method: 'deleteRecipe',
    description:
      'Elimina la RECETA (lista de ingredientes) de un producto. NO elimina el producto del menú, solo su receta. Usa esta función cuando el usuario diga "eliminar receta" o "borrar receta".',
    examples: [
      'Elimina la receta del hamburguesa clásica',
      'Borra la receta del café americano',
      'elimina receta pizza margarita',
      'quitar receta del smoothie de mango',
      'delete recipe tacos de pollo',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿De qué producto quieres eliminar la receta?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
      resolveVia: {
        intermediateEntity: 'Product',
        intermediateField: 'name',
        linkField: 'productId',
      },
    },
    serviceAdapter: async (params, context) => {
      const { entityId } = params as any
      return recipeService.deleteRecipe(context.venueId, entityId as string)
    },
    previewTemplate: {
      title: 'Eliminar receta: {{name}}',
      summary: 'Se eliminará permanentemente la receta del producto "{{name}}". Esta acción no se puede deshacer.',
      showDiff: false,
      showImpact: true,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.recipe.addLine
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.recipe.addLine',
    entity: 'RecipeLine',
    operation: 'custom',
    permission: 'menu:update',
    dangerLevel: 'low',
    service: 'recipeService',
    method: 'addRecipeLine',
    description:
      'Agrega un INGREDIENTE (materia prima) a la RECETA de un producto. Usa esta función cuando el usuario diga "agregar ingrediente a la receta" o "agregar X a la receta de Y".',
    examples: [
      'Agrega 5g de sal a la receta de la hamburguesa',
      'Añade 10ml de aceite de oliva a la receta de la pizza',
      'agregar ingrediente: 2 unidades de huevo a la receta de los hotcakes',
      'add 30g queso parmesano a receta pasta alfredo',
      'incluye 1 pieza de aguacate en la receta de la ensalada',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿A qué producto quieres agregarle un ingrediente?',
      },
      ingredientName: {
        type: 'string',
        required: true,
        prompt: '¿Cuál ingrediente quieres agregar?',
      },
      quantity: {
        type: 'decimal',
        required: true,
        prompt: '¿Qué cantidad de este ingrediente se usará por porción?',
        min: 0.001,
      },
      unit: {
        type: 'enum',
        required: true,
        prompt: '¿En qué unidad se mide este ingrediente?',
        options: ['GRAM', 'KILOGRAM', 'MILLILITER', 'LITER', 'UNIT', 'PIECE'],
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
      resolveVia: {
        intermediateEntity: 'Product',
        intermediateField: 'name',
        linkField: 'productId',
      },
    },
    serviceAdapter: async (params, context) => {
      const { entityId, ingredientName, quantity, unit } = params as any

      // Resolve ingredient name to rawMaterialId
      const resolved = await resolveRecipeLines([{ name: ingredientName, quantity: Number(quantity), unit }], context.venueId)
      if (resolved.length === 0) {
        throw new Error(`No se encontró el ingrediente "${ingredientName}" en el inventario.`)
      }

      return recipeService.addRecipeLine(context.venueId, entityId as string, {
        rawMaterialId: resolved[0].rawMaterialId,
        quantity: Number(quantity),
        unit: unit as string,
        isOptional: false,
      })
    },
    previewTemplate: {
      title: 'Agregar ingrediente a receta: {{name}}',
      summary: 'Se agregará {{quantity}} {{unit}} de "{{ingredientName}}" a la receta de "{{name}}".',
      showDiff: true,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.recipe.recalculateCost
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.recipe.recalculateCost',
    entity: 'Recipe',
    operation: 'custom',
    permission: 'menu:update',
    dangerLevel: 'low',
    service: 'recipeService',
    method: 'recalculateRecipeCost',
    description: 'Recalcula el costo total de la receta basándose en los precios actuales de los ingredientes',
    examples: [
      'recalcula el costo de la receta de hamburguesa',
      'actualiza el costo de preparar la pizza',
      'recalcular costo de la receta del café americano',
      'actualiza el costo de ingredientes del smoothie de mango',
      'recalcula el precio de costo de los tacos de pollo',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿De qué producto quieres recalcular el costo de la receta?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
      resolveVia: {
        intermediateEntity: 'Product',
        intermediateField: 'name',
        linkField: 'productId',
      },
    },
    serviceAdapter: async (params, context) => {
      const { entityId } = params as any

      // entityId is productId (from two-hop resolution via Product)
      // Look up the recipe by productId to get the recipeId
      const recipe = await prisma.recipe.findFirst({
        where: { productId: entityId as string },
        select: { id: true },
      })

      if (!recipe) {
        throw new Error('No se encontró una receta para este producto.')
      }

      return recipeService.recalculateRecipeCost(recipe.id)
    },
    previewTemplate: {
      title: 'Recalcular costo de receta: {{name}}',
      summary: 'Se recalculará el costo total de la receta de "{{name}}" usando los precios actuales de los ingredientes.',
      showDiff: true,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.recipe.removeLine
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.recipe.removeLine',
    entity: 'RecipeLine',
    operation: 'custom',
    permission: 'menu:update',
    dangerLevel: 'medium',
    service: 'recipeService',
    method: 'removeRecipeLine',
    description: 'Elimina un ingrediente específico de la receta de un producto',
    examples: [
      'Quita la sal de la receta de la hamburguesa',
      'Elimina el aceite de oliva de la receta de la pizza',
      'remover ingrediente huevo de la receta de hotcakes',
      'quita el queso parmesano de la receta de pasta alfredo',
      'elimina aguacate de la receta de la ensalada',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿De qué producto quieres quitar un ingrediente?',
      },
      ingredientName: {
        type: 'string',
        required: true,
        prompt: '¿Cuál ingrediente quieres quitar?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
      resolveVia: {
        intermediateEntity: 'Product',
        intermediateField: 'name',
        linkField: 'productId',
      },
    },
    serviceAdapter: async (params, context) => {
      const { entityId, ingredientName } = params as any

      // Find the recipe line by ingredient name
      const recipe = await prisma.recipe.findFirst({
        where: { productId: entityId as string },
        include: {
          lines: {
            include: { rawMaterial: { select: { name: true } } },
          },
        },
      })

      if (!recipe) throw new Error('No se encontró la receta.')

      const line = recipe.lines.find((l: any) => l.rawMaterial?.name?.toLowerCase().includes((ingredientName as string).toLowerCase()))
      if (!line) throw new Error(`No se encontró el ingrediente "${ingredientName}" en la receta.`)

      return recipeService.removeRecipeLine(context.venueId, entityId as string, line.id)
    },
    previewTemplate: {
      title: 'Quitar ingrediente de receta: {{name}}',
      summary: 'Se quitará "{{ingredientName}}" de la receta de "{{name}}".',
      showDiff: true,
      showImpact: true,
    },
  },
]
