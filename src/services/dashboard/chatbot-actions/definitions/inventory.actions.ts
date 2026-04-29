import { ActionDefinition } from '../types'
import * as rawMaterialService from '../../rawMaterial.service'

export const inventoryActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // inventory.rawMaterial.create
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.rawMaterial.create',
    entity: 'RawMaterial',
    operation: 'create',
    permission: 'inventory:create',
    dangerLevel: 'low',
    service: 'rawMaterialService',
    method: 'createRawMaterial',
    description: 'Crea un nuevo insumo/materia prima en el inventario del venue',
    examples: [
      'Agrega un insumo de tomate, 5kg, precio $20 por kilo',
      'Crear materia prima: harina de trigo, SKU HAR001, categoría GRAINS, stock inicial 50kg',
      'Necesito agregar jitomates al inventario, tengo 10 kilos a $15 c/u',
      'nuevo insumo pollo entero categoria POULTRY, sku POL001, costo 85 pesos el kilo',
      'agrega queso manchego inventario, 20 unidades, $130 cada una',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el nombre del insumo?',
      },
      sku: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el SKU o código del insumo?',
        transform: 'uppercase',
        unique: true,
      },
      category: {
        type: 'enum',
        required: true,
        prompt: '¿A qué categoría pertenece el insumo?',
        options: [
          'MEAT',
          'POULTRY',
          'SEAFOOD',
          'DAIRY',
          'CHEESE',
          'EGGS',
          'VEGETABLES',
          'FRUITS',
          'GRAINS',
          'BREAD',
          'PASTA',
          'RICE',
          'BEANS',
          'SPICES',
          'HERBS',
          'OILS',
          'SAUCES',
          'CONDIMENTS',
          'BEVERAGES',
          'ALCOHOL',
          'CLEANING',
          'PACKAGING',
          'OTHER',
        ],
      },
      unit: {
        type: 'enum',
        required: true,
        prompt: '¿En qué unidad se mide el insumo? (ej. KILOGRAM, LITER, UNIT)',
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
          'METER',
          'CENTIMETER',
          'MILLIMETER',
          'INCH',
          'FOOT',
          'CELSIUS',
          'FAHRENHEIT',
          'MINUTE',
          'HOUR',
          'DAY',
        ],
      },
      costPerUnit: {
        type: 'decimal',
        required: true,
        prompt: '¿Cuál es el costo por unidad del insumo?',
        min: 0.01,
      },
      currentStock: {
        type: 'decimal',
        required: true,
        prompt: '¿Cuánto stock inicial tiene el insumo?',
        min: 0,
        default: 0,
      },
      minimumStock: {
        type: 'decimal',
        required: true,
        prompt: '¿Cuál es el stock mínimo antes de emitir alerta?',
        min: 0,
        default: 0,
      },
      reorderPoint: {
        type: 'decimal',
        required: true,
        prompt: '¿A qué nivel de stock se debe reordenar?',
        min: 0,
        default: 0,
      },
      description: {
        type: 'string',
        required: false,
        prompt: '¿Tienes alguna descripción adicional para el insumo?',
      },
      perishable: {
        type: 'boolean',
        required: false,
        prompt: '¿El insumo es perecedero?',
        default: false,
      },
      shelfLifeDays: {
        type: 'integer',
        required: false,
        prompt: '¿Cuántos días de vida útil tiene el insumo?',
        min: 1,
      },
    },
    serviceAdapter: async (params, context) => {
      return rawMaterialService.createRawMaterial(context.venueId, params as any)
    },
    previewTemplate: {
      title: 'Crear insumo: {{name}}',
      summary: 'Se creará el insumo "{{name}}" (SKU: {{sku}}) con stock inicial {{currentStock}} {{unit}} a ${{costPerUnit}} por unidad.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.rawMaterial.update
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.rawMaterial.update',
    entity: 'RawMaterial',
    operation: 'update',
    permission: 'inventory:update',
    dangerLevel: 'medium',
    service: 'rawMaterialService',
    method: 'updateRawMaterial',
    description: 'Actualiza los datos de un insumo existente (nombre, costo, stock mínimo, etc.)',
    examples: [
      'Actualiza el costo del tomate a $22 por kilo',
      'Cambia el stock mínimo de la harina a 30kg',
      'update precio pollo a 90 pesos',
      'Modifica el insumo aceite de oliva, nueva descripción: aceite español importado',
      'cambia el sku del queso manchego a QM-ESP-001',
    ],
    fields: {
      name: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el nuevo nombre del insumo?',
      },
      costPerUnit: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es el nuevo costo por unidad?',
        min: 0.01,
      },
      minimumStock: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es el nuevo stock mínimo?',
        min: 0,
      },
      reorderPoint: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es el nuevo punto de reorden?',
        min: 0,
      },
      maximumStock: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es el nuevo stock máximo?',
        min: 0,
      },
      description: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es la nueva descripción del insumo?',
      },
      perishable: {
        type: 'boolean',
        required: false,
        prompt: '¿El insumo es perecedero?',
      },
      shelfLifeDays: {
        type: 'integer',
        required: false,
        prompt: '¿Cuántos días de vida útil tiene el insumo?',
        min: 1,
      },
      active: {
        type: 'boolean',
        required: false,
        prompt: '¿El insumo está activo?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId, ...updateData } = params as any
      return rawMaterialService.updateRawMaterial(context.venueId, entityId as string, updateData)
    },
    previewTemplate: {
      title: 'Actualizar insumo: {{name}}',
      summary: 'Se actualizarán los campos del insumo "{{name}}".',
      showDiff: true,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.rawMaterial.delete
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.rawMaterial.delete',
    entity: 'RawMaterial',
    operation: 'delete',
    permission: 'inventory:delete',
    dangerLevel: 'high',
    service: 'rawMaterialService',
    method: 'deactivateRawMaterial',
    description: 'Desactiva un insumo del inventario (no se puede eliminar si está en uso en recetas)',
    examples: [
      'Desactiva el insumo de tomate bola',
      'Elimina la materia prima harina de maíz del inventario',
      'borra el insumo aceite de ajonjolí',
      'quitar insumo sal de grano del inventario',
      'desactiva el queso panela',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál insumo quieres desactivar?',
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
      return rawMaterialService.deactivateRawMaterial(context.venueId, entityId as string)
    },
    previewTemplate: {
      title: 'Desactivar insumo: {{name}}',
      summary: 'Se desactivará el insumo "{{name}}". Esta acción no eliminará el historial ni las recetas existentes.',
      showDiff: false,
      showImpact: true,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.rawMaterial.reactivate
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.rawMaterial.reactivate',
    entity: 'RawMaterial',
    operation: 'delete', // 'delete' so entity resolver includes inactive materials (active=false, deletedAt IS NULL)
    permission: 'inventory:update',
    dangerLevel: 'low',
    service: 'rawMaterialService',
    method: 'reactivateRawMaterial',
    description: 'Reactiva un insumo previamente desactivado para que vuelva a estar disponible en el inventario',
    examples: [
      'Reactiva el insumo de tomate bola que desactivé antes',
      'vuelve a activar la materia prima harina de maíz',
      'reactivar insumo aceite de ajonjolí',
      'activa de nuevo el insumo queso panela',
      'habilitar de nuevo la sal de grano en inventario',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál insumo desactivado quieres reactivar?',
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
      return rawMaterialService.reactivateRawMaterial(context.venueId, entityId as string)
    },
    previewTemplate: {
      title: 'Reactivar insumo: {{name}}',
      summary: 'Se reactivará el insumo "{{name}}". Volverá a aparecer en el inventario y podrá usarse en recetas y órdenes de compra.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.rawMaterial.adjustStock
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.rawMaterial.adjustStock',
    entity: 'RawMaterial',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'medium',
    service: 'rawMaterialService',
    method: 'adjustStock',
    description: 'Ajusta el stock de un insumo (positivo para agregar, negativo para reducir)',
    examples: [
      'Agrega 10kg de tomate al inventario',
      'Reduce el stock de harina en 5kg por merma',
      'ajusta pollo +20 kilos, llegó nueva entrega',
      'Inventario físico: actualiza queso manchego a -3 unidades por caducidad',
      'ajuste manual aceite de oliva +2 litros compra directa',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿A cuál insumo quieres ajustarle el stock?',
      },
      quantity: {
        type: 'decimal',
        required: true,
        prompt: '¿Cuánto quieres ajustar el stock? (positivo para agregar, negativo para reducir)',
      },
      type: {
        type: 'enum',
        required: true,
        prompt: '¿Cuál es el motivo del ajuste?',
        options: ['PURCHASE', 'USAGE', 'ADJUSTMENT', 'SPOILAGE', 'TRANSFER', 'COUNT', 'RETURN'],
        default: 'ADJUSTMENT',
      },
      reason: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es la razón del ajuste? (opcional)',
      },
      reference: {
        type: 'string',
        required: false,
        prompt: '¿Hay alguna referencia o número de pedido relacionado? (opcional)',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId, quantity, type, reason, reference } = params as any
      return rawMaterialService.adjustStock(
        context.venueId,
        entityId as string,
        { quantity: Number(quantity), type, reason, reference },
        context.userId,
      )
    },
    previewTemplate: {
      title: 'Ajustar stock: {{name}}',
      summary: 'Se ajustará el stock del insumo "{{entityName}}" en {{quantity}} {{unit}}. Tipo: {{type}}.',
      showDiff: true,
      showImpact: true,
    },
  },
]
