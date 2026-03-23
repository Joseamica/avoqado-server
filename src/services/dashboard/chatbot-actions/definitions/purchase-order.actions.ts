import prisma from '@/utils/prismaClient'
import { ActionDefinition } from '../types'
import * as purchaseOrderService from '../../purchaseOrder.service'

export const purchaseOrderActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.create
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.create',
    entity: 'PurchaseOrder',
    operation: 'create',
    permission: 'inventory:create',
    dangerLevel: 'low',
    service: 'purchaseOrderService',
    method: 'createPurchaseOrder',
    description: 'Crea una nueva orden de compra para un proveedor con los insumos requeridos',
    examples: [
      'Crea una orden de compra para el proveedor Distribuidora López, 50kg de pollo a $85/kg',
      'Nueva orden de compra: proveedor Lácteos del Norte, 20 litros leche a $18 c/u, fecha para hoy',
      'genera orden de compra con proveedor ID cma123, tomate 100kg a $20, habanero 5kg a $30',
      'Quiero pedir a mi proveedor principal: 30kg harina, 10 litros aceite',
      'orden compra urgente para proveedor Carnes Premium, 40kg costilla $120/kg',
    ],
    fields: {
      supplierName: {
        type: 'string',
        required: true,
        prompt: '¿Cuál es el nombre del proveedor para esta orden?',
      },
      orderDate: {
        type: 'date',
        required: true,
        prompt: '¿Cuál es la fecha de la orden? (formato ISO 8601)',
      },
      expectedDeliveryDate: {
        type: 'date',
        required: false,
        prompt: '¿Cuándo se espera la entrega? (formato ISO 8601)',
      },
      taxRate: {
        type: 'decimal',
        required: false,
        prompt: '¿Cuál es la tasa de IVA? (ej. 0.16 para 16%)',
        min: 0,
        max: 1,
        default: 0.16,
      },
      notes: {
        type: 'string',
        required: false,
        prompt: '¿Tienes alguna nota especial para esta orden?',
      },
    },
    listField: {
      name: 'items',
      description: 'Lista de insumos a ordenar con cantidad, unidad y precio unitario',
      minItems: 1,
      itemFields: {
        rawMaterialName: {
          type: 'string',
          required: true,
          prompt: '¿Cuál es el nombre del insumo?',
        },
        quantity: {
          type: 'decimal',
          required: true,
          prompt: '¿Cuántas unidades quieres ordenar?',
          min: 0.001,
        },
        unit: {
          type: 'enum',
          required: true,
          prompt: '¿En qué unidad se mide?',
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
        unitPrice: {
          type: 'decimal',
          required: true,
          prompt: '¿Cuál es el precio unitario?',
          min: 0.01,
        },
      },
    },
    serviceAdapter: async (params, context) => {
      const { supplierName, orderDate, expectedDeliveryDate, taxRate, notes, items } = params as any

      // Resolve supplier by name
      let supplierId: string | undefined
      if (supplierName) {
        const supplier = await prisma.supplier.findFirst({
          where: {
            venueId: context.venueId,
            active: true,
            name: { contains: supplierName, mode: 'insensitive' },
          },
          select: { id: true },
        })
        if (supplier) {
          supplierId = supplier.id
        } else {
          // Try fuzzy match
          const fuzzy = await prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "Supplier"
            WHERE "venueId" = ${context.venueId} AND "active" = true
              AND similarity(name, ${supplierName}) > 0.2
            ORDER BY similarity(name, ${supplierName}) DESC
            LIMIT 1
          `
          if (fuzzy.length > 0) supplierId = fuzzy[0].id
        }
      }
      if (!supplierId) throw new Error(`No se encontró el proveedor "${supplierName}".`)

      // Resolve raw material names to IDs for each item
      const resolvedItems: Array<{ rawMaterialId: string; quantityOrdered: number; unit: string; unitPrice: number }> = []
      const rawItems = (items as any[]) ?? []
      for (const item of rawItems) {
        const searchName = item.rawMaterialName as string
        if (!searchName) continue

        let rawMaterialId: string | undefined
        const rm = await prisma.rawMaterial.findFirst({
          where: {
            venueId: context.venueId,
            active: true,
            deletedAt: null,
            name: { contains: searchName, mode: 'insensitive' },
          },
          select: { id: true },
        })
        if (rm) {
          rawMaterialId = rm.id
        } else {
          const fuzzy = await prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "RawMaterial"
            WHERE "venueId" = ${context.venueId} AND "active" = true AND "deletedAt" IS NULL
              AND similarity(name, ${searchName}) > 0.2
            ORDER BY similarity(name, ${searchName}) DESC
            LIMIT 1
          `
          if (fuzzy.length > 0) rawMaterialId = fuzzy[0].id
        }
        if (!rawMaterialId) throw new Error(`No se encontró el insumo "${searchName}" en el inventario.`)

        resolvedItems.push({
          rawMaterialId,
          quantityOrdered: Number(item.quantity),
          unit: item.unit as string,
          unitPrice: Number(item.unitPrice),
        })
      }

      if (resolvedItems.length === 0) {
        throw new Error('La orden de compra necesita al menos un artículo.')
      }

      return purchaseOrderService.createPurchaseOrder(
        context.venueId,
        {
          supplierId,
          orderDate: orderDate || new Date().toISOString(),
          expectedDeliveryDate: expectedDeliveryDate as string | undefined,
          taxRate: taxRate ? Number(taxRate) : 0.16,
          notes: notes as string | undefined,
          items: resolvedItems,
        } as any,
        context.userId,
      )
    },
    previewTemplate: {
      title: 'Crear orden de compra para: {{supplierName}}',
      summary: 'Se creará una orden de compra en estado BORRADOR para el proveedor "{{supplierName}}" con fecha {{orderDate}}.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.approve
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.approve',
    entity: 'PurchaseOrder',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'medium',
    service: 'purchaseOrderService',
    method: 'approvePurchaseOrder',
    description: 'Aprueba una orden de compra en estado BORRADOR o PENDIENTE_APROBACIÓN',
    examples: [
      'Aprueba la orden de compra PO20260321-001',
      'Autoriza la orden de compra del proveedor Distribuidora López',
      'aprobar orden PO2026032-001',
      'aprueba el pedido pendiente de Lácteos del Norte',
      'autorizar orden de compra más reciente de Carnes Premium',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál orden de compra quieres aprobar? (número de orden o nombre del proveedor)',
      },
    },
    entityResolution: {
      searchField: 'orderNumber',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId } = params as any
      return purchaseOrderService.approvePurchaseOrder(context.venueId, entityId as string, context.userId)
    },
    previewTemplate: {
      title: 'Aprobar orden de compra: {{orderNumber}}',
      summary: 'Se aprobará la orden de compra "{{orderNumber}}". El estado cambiará de BORRADOR/PENDIENTE_APROBACIÓN a APROBADO.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.receive
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.receive',
    entity: 'PurchaseOrder',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'medium',
    service: 'purchaseOrderService',
    method: 'receivePurchaseOrder',
    description: 'Registra la recepción de mercancía de una orden de compra y actualiza el stock automáticamente',
    examples: [
      'Recibe la orden PO20260321-001, todos los artículos llegaron completos',
      'Registra recepción parcial de orden Distribuidora López: solo llegaron 40 de 50kg de pollo',
      'receive orden de compra lácteos, fecha de recepción hoy',
      'marcar como recibida la orden de Carnes Premium del día de hoy',
      'registrar mercancía recibida para la orden PO20260320-002',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál orden de compra recibiste? (número de orden o nombre del proveedor)',
      },
      receivedDate: {
        type: 'date',
        required: false,
        prompt: '¿Cuál es la fecha en que se recibió la mercancía?',
      },
    },
    listField: {
      name: 'receivedItems',
      description: 'Lista de artículos recibidos con el ID del item de la orden y la cantidad recibida',
      minItems: 0,
      itemFields: {
        rawMaterialName: {
          type: 'string',
          required: true,
          prompt: '¿Cuál insumo recibiste?',
        },
        quantityReceived: {
          type: 'decimal',
          required: true,
          prompt: '¿Cuántas unidades recibiste?',
          min: 0.001,
        },
      },
    },
    entityResolution: {
      searchField: 'orderNumber',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId, receivedDate, receivedItems } = params as any

      // Fetch the PO items to map raw material names to purchaseOrderItemIds
      const po = await prisma.purchaseOrder.findFirst({
        where: { id: entityId as string, venueId: context.venueId },
        include: {
          items: {
            include: { rawMaterial: { select: { id: true, name: true } } },
          },
        },
      })
      if (!po) throw new Error('No se encontró la orden de compra.')

      const rawReceivedItems = (receivedItems as any[]) ?? []
      let resolvedItems: Array<{ purchaseOrderItemId: string; quantityReceived: number }> = []

      if (rawReceivedItems.length > 0) {
        // Map received item names to purchaseOrderItem IDs
        for (const item of rawReceivedItems) {
          const searchName = ((item.rawMaterialName as string) || '').toLowerCase()
          if (!searchName) continue

          const poItem = po.items.find((pi: any) => pi.rawMaterial?.name?.toLowerCase().includes(searchName))
          if (!poItem) throw new Error(`No se encontró el insumo "${item.rawMaterialName}" en esta orden de compra.`)

          resolvedItems.push({
            purchaseOrderItemId: poItem.id,
            quantityReceived: Number(item.quantityReceived),
          })
        }
      } else {
        // If no specific items provided, receive all items with their full ordered quantity
        resolvedItems = po.items.map((poItem: any) => ({
          purchaseOrderItemId: poItem.id,
          quantityReceived: Number(poItem.quantityOrdered),
        }))
      }

      return purchaseOrderService.receivePurchaseOrder(
        context.venueId,
        entityId as string,
        {
          receivedDate: (receivedDate as string) || new Date().toISOString(),
          items: resolvedItems,
        },
        context.userId,
      )
    },
    previewTemplate: {
      title: 'Registrar recepción: {{orderNumber}}',
      summary:
        'Se registrará la recepción de la orden "{{orderNumber}}" con fecha {{receivedDate}}. El stock de los insumos se actualizará automáticamente.',
      showDiff: false,
      showImpact: true,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.cancel
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.cancel',
    entity: 'PurchaseOrder',
    operation: 'custom',
    permission: 'inventory:delete',
    dangerLevel: 'high',
    service: 'purchaseOrderService',
    method: 'cancelPurchaseOrder',
    description: 'Cancela una orden de compra. No se pueden cancelar órdenes ya recibidas.',
    examples: [
      'Cancela la orden de compra PO20260321-001',
      'Anula el pedido a Distribuidora López por falta de presupuesto',
      'cancelar orden PO20260320-002, el proveedor no puede surtir',
      'anula la orden de Lácteos del Norte, motivo: cambio de proveedor',
      'cancel orden de compra más reciente de Carnes Premium',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál orden de compra quieres cancelar? (número de orden o nombre del proveedor)',
      },
      reason: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el motivo de la cancelación? (opcional)',
      },
    },
    entityResolution: {
      searchField: 'orderNumber',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId, reason } = params as any
      return purchaseOrderService.cancelPurchaseOrder(context.venueId, entityId as string, reason as string | undefined, context.userId)
    },
    previewTemplate: {
      title: 'Cancelar orden de compra: {{orderNumber}}',
      summary: 'Se cancelará la orden de compra "{{orderNumber}}". Esta acción no puede deshacerse si la orden ya fue enviada.',
      showDiff: false,
      showImpact: true,
    },
  },
]
