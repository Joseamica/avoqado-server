import { ActionDefinition, ActionContext } from '../types'
import * as supplierService from '../../supplier.service'
import prisma from '@/utils/prismaClient'

export const supplierActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // supplier.create
  // ---------------------------------------------------------------------------
  {
    actionType: 'supplier.create',
    entity: 'Supplier',
    operation: 'create',
    permission: 'inventory:create',
    dangerLevel: 'low',
    service: 'supplierService',
    method: 'createSupplier',
    description: 'Crea un nuevo proveedor en el venue',
    examples: [
      'agrega proveedor Distribuidora Lopez',
      'nuevo proveedor Carnes Premium tel 555-1234',
      'crea un proveedor llamado Frutas del Norte, contacto Juan, email juan@frutas.com',
      'añade el proveedor Lacteos SA de CV con telefono 55-8899-0011',
      'agregar supplier Verduras Express, direccion Av. Central 45, ciudad CDMX',
      'new supplier Bebidas del Pacifico, notes: entrega los martes y jueves',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el nombre del proveedor?',
      },
      contactName: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el nombre del contacto en el proveedor?',
      },
      email: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el correo electrónico del proveedor?',
      },
      phone: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el teléfono del proveedor?',
      },
      address: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es la dirección del proveedor?',
      },
      city: {
        type: 'string',
        required: false,
        prompt: '¿En qué ciudad se encuentra el proveedor?',
      },
      notes: {
        type: 'string',
        required: false,
        prompt: '¿Tienes alguna nota adicional sobre el proveedor?',
      },
    },
    serviceAdapter: async (params: Record<string, unknown>, context: ActionContext) => {
      return supplierService.createSupplier(context.venueId, params as any)
    },
    previewTemplate: {
      title: 'Crear proveedor: {{name}}',
      summary: 'Se creará el proveedor "{{name}}". Contacto: {{contactName}}, Tel: {{phone}}.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // supplier.update
  // ---------------------------------------------------------------------------
  {
    actionType: 'supplier.update',
    entity: 'Supplier',
    operation: 'update',
    permission: 'inventory:update',
    dangerLevel: 'medium',
    service: 'supplierService',
    method: 'updateSupplier',
    description: 'Actualiza los datos de un proveedor existente (teléfono, email, calificación, notas, etc.)',
    examples: [
      'actualiza el telefono del proveedor Lopez a 555-9999',
      'cambia el email de Carnes Premium a ventas@carnespremium.mx',
      'update proveedor Frutas del Norte, nuevo contacto: Maria García',
      'modifica el rating de Distribuidora Lopez a 4.5',
      'pon las notas del proveedor Lacteos SA: ya no entregan los lunes',
      'change phone supplier Verduras Express to 55-1234-5678',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el nombre del proveedor que deseas actualizar?',
      },
      contactName: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el nuevo nombre de contacto?',
      },
      email: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el nuevo correo electrónico?',
      },
      phone: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el nuevo teléfono?',
      },
      rating: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es la nueva calificación del proveedor? (0-5)',
        min: 0,
        max: 5,
      },
      notes: {
        type: 'string',
        required: false,
        prompt: '¿Cuáles son las nuevas notas sobre el proveedor?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params: Record<string, unknown>, context: ActionContext) => {
      const { entityId, name: _name, ...updateData } = params as any
      return supplierService.updateSupplier(context.venueId, entityId as string, updateData)
    },
    previewTemplate: {
      title: 'Actualizar proveedor: {{name}}',
      summary: 'Se actualizarán los datos del proveedor "{{name}}".',
      showDiff: true,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // supplier.delete
  // ---------------------------------------------------------------------------
  {
    actionType: 'supplier.delete',
    entity: 'Supplier',
    operation: 'delete',
    permission: 'inventory:delete',
    dangerLevel: 'high',
    service: 'supplierService',
    method: 'deleteSupplier',
    description: 'Elimina (soft delete) un proveedor del venue. No se puede eliminar si tiene órdenes de compra asociadas.',
    examples: [
      'elimina el proveedor Lopez',
      'borra el proveedor Carnes Premium',
      'quitar proveedor Frutas del Norte del sistema',
      'desactiva al proveedor Distribuidora Perez',
      'remove supplier Lacteos SA de CV',
      'delete proveedor Verduras Express, ya no trabajamos con ellos',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el nombre del proveedor que deseas eliminar?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params: Record<string, unknown>, context: ActionContext) => {
      const { entityId } = params as any
      return supplierService.deleteSupplier(context.venueId, entityId as string, context.userId)
    },
    previewTemplate: {
      title: 'Eliminar proveedor: {{name}}',
      summary:
        'Se eliminará el proveedor "{{name}}". Esta acción no se puede deshacer si el proveedor no tiene órdenes de compra asociadas.',
      showDiff: false,
      showImpact: true,
    },
  },

  // ---------------------------------------------------------------------------
  // supplier.createPricing
  // ---------------------------------------------------------------------------
  {
    actionType: 'supplier.createPricing',
    entity: 'Supplier',
    operation: 'custom',
    permission: 'inventory:create',
    dangerLevel: 'low',
    service: 'supplierService',
    method: 'createSupplierPricing',
    description: 'Registra el precio de un insumo para un proveedor específico (reemplaza el precio activo anterior)',
    examples: [
      'el proveedor Lopez vende harina a 42 pesos el kilo',
      'agrega precio: Carnes Premium vende pollo a 89/kg',
      'registra que Frutas del Norte vende jitomate a 18 pesos por kilo',
      'proveedor Lacteos SA vende queso manchego a 130 la pieza',
      'add pricing: supplier Distribuidora Lopez sells aceite a 65 pesos el litro',
      'pon precio de tomate con Verduras Express: 15 pesos el kg, vigente desde hoy',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el nombre del proveedor?',
      },
      rawMaterialName: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el insumo que vende el proveedor?',
      },
      pricePerUnit: {
        type: 'decimal',
        required: true,
        prompt: '¿Cuál es el precio por unidad?',
        min: 0.01,
      },
      unit: {
        type: 'enum',
        required: false,
        prompt: '¿En qué unidad se mide? (ej. KILOGRAM, LITER, UNIT)',
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
        ],
        default: 'KILOGRAM',
      },
      effectiveFrom: {
        type: 'date',
        required: false,
        prompt: '¿Desde qué fecha es válido este precio? (por defecto: hoy)',
        default: 'today',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params: Record<string, unknown>, context: ActionContext) => {
      const { entityId, name: _name, rawMaterialName, pricePerUnit, unit, effectiveFrom } = params as any

      // Resolve rawMaterial by name within the venue
      const rawMaterial = await prisma.rawMaterial.findFirst({
        where: {
          venueId: context.venueId,
          name: { contains: rawMaterialName as string, mode: 'insensitive' },
          deletedAt: null,
        },
      })

      if (!rawMaterial) {
        throw new Error(`No se encontró el insumo "${rawMaterialName}" en el inventario`)
      }

      const today = new Date().toISOString().split('T')[0]

      return supplierService.createSupplierPricing(context.venueId, entityId as string, {
        rawMaterialId: rawMaterial.id,
        pricePerUnit: Number(pricePerUnit),
        unit: (unit as string) || 'KILOGRAM',
        minimumQuantity: 1,
        effectiveFrom: (effectiveFrom as string) || today,
      })
    },
    previewTemplate: {
      title: 'Registrar precio: {{name}} → {{rawMaterialName}}',
      summary: 'Se registrará el precio de "{{rawMaterialName}}" con el proveedor "{{name}}" a ${{pricePerUnit}} por {{unit}}.',
      showDiff: false,
      showImpact: false,
    },
  },
]
