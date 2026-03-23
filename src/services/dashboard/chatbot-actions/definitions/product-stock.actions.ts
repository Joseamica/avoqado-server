import { ActionDefinition } from '../types'
import * as productInventoryService from '../../productInventory.service'
import prisma from '../../../../utils/prismaClient'
import { Prisma } from '@prisma/client'

export const productStockActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // inventory.product.adjustStock
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.product.adjustStock',
    entity: 'Product',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'medium',
    service: 'productInventoryService',
    method: 'adjustInventoryStock',
    description: 'Ajusta el stock de un producto con seguimiento de inventario por cantidad (no por receta)',
    examples: [
      'Ajusta el stock del vino tinto Malbec, llegan 12 botellas más',
      'Reduce el inventario de cerveza Corona en 6 unidades por pérdida',
      'ajuste manual: agrega 50 unidades de agua mineral al inventario',
      'registra entrada de 24 latas de refresco Coca Cola',
      'descuento de 5 piezas de copas de cristal por rotura',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿A cuál producto quieres ajustarle el stock?',
      },
      quantity: {
        type: 'decimal',
        required: true,
        prompt: '¿Cuánto quieres ajustar el stock? (positivo para agregar, negativo para reducir)',
      },
      type: {
        type: 'enum',
        required: true,
        prompt: '¿Cuál es el tipo de movimiento?',
        options: ['PURCHASE', 'SALE', 'ADJUSTMENT', 'LOSS', 'TRANSFER', 'COUNT'],
        default: 'ADJUSTMENT',
      },
      reason: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el motivo del ajuste? (opcional)',
      },
      reference: {
        type: 'string',
        required: false,
        prompt: '¿Hay alguna referencia o documento relacionado? (opcional)',
      },
      unitCost: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es el costo unitario? (requerido solo para tipo PURCHASE)',
        min: 0,
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId, quantity, type, reason, reference, unitCost } = params as any
      return productInventoryService.adjustInventoryStock(
        context.venueId,
        entityId as string,
        {
          quantity: Number(quantity),
          type: type as any,
          reason: reason as string | undefined,
          reference: reference as string | undefined,
          unitCost: unitCost ? Number(unitCost) : undefined,
        },
        context.userId,
      )
    },
    previewTemplate: {
      title: 'Ajustar stock de producto: {{name}}',
      summary: 'Se ajustará el stock del producto "{{name}}" en {{quantity}} unidades. Tipo de movimiento: {{type}}.',
      showDiff: true,
      showImpact: true,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.product.setMinimum
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.product.setMinimum',
    entity: 'Product',
    operation: 'update',
    permission: 'inventory:update',
    dangerLevel: 'low',
    service: 'productInventoryService',
    method: 'setMinimumStock',
    description: 'Establece el stock mínimo de un producto para activar alertas de reabastecimiento',
    examples: [
      'Establece el stock mínimo del vino tinto en 6 botellas',
      'Cambia el mínimo de inventario de cerveza Corona a 24 unidades',
      'set mínimo de agua mineral a 30 piezas',
      'actualiza el stock mínimo de copas cristal a 10 unidades',
      'minimum stock para refresco Coca Cola: 48 latas',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿A cuál producto quieres cambiarle el stock mínimo?',
      },
      minimumStock: {
        type: 'decimal',
        required: true,
        prompt: '¿Cuál es el nuevo stock mínimo para este producto?',
        min: 0,
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId, minimumStock } = params as any

      // Verify product exists and belongs to venue
      const product = await prisma.product.findFirst({
        where: { id: entityId as string, venueId: context.venueId },
        include: { inventory: true },
      })

      if (!product) {
        throw new Error(`Producto con ID ${entityId} no encontrado`)
      }

      if (!product.inventory) {
        throw new Error(`El producto ${product.name} no tiene registro de inventario`)
      }

      const updated = await prisma.inventory.update({
        where: { id: product.inventory.id },
        data: {
          minimumStock: new Prisma.Decimal(Number(minimumStock)),
        },
      })

      return {
        productId: entityId,
        minimumStock: updated.minimumStock.toNumber(),
        currentStock: updated.currentStock.toNumber(),
      }
    },
    previewTemplate: {
      title: 'Actualizar stock mínimo: {{name}}',
      summary: 'Se establecerá el stock mínimo del producto "{{name}}" a {{minimumStock}} unidades.',
      showDiff: true,
      showImpact: false,
    },
  },
]
