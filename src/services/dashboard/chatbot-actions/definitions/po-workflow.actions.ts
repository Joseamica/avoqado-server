import { ActionDefinition } from '../types'
import * as purchaseOrderWorkflowService from '../../purchaseOrderWorkflow.service'
import * as purchaseOrderService from '../../purchaseOrder.service'

export const poWorkflowActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.submitForApproval
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.submitForApproval',
    entity: 'PurchaseOrder',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'low',
    service: 'purchaseOrderWorkflowService',
    method: 'submitForApproval',
    description: 'Envía una orden de compra en estado BORRADOR a revisión para su aprobación',
    examples: [
      'Manda la orden PO20260321-001 a aprobación',
      'enviar orden de compra de Distribuidora López para que la aprueben',
      'submit orden de compra PO2026032-002 a revisión',
      'mandar a aprobar el pedido de Lácteos del Norte',
      'envía la orden de compra más reciente de Carnes Premium para aprobación',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál orden de compra quieres enviar a aprobación? (número de orden o nombre del proveedor)',
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
      return purchaseOrderWorkflowService.submitForApproval(context.venueId, entityId as string, context.userId)
    },
    previewTemplate: {
      title: 'Enviar a aprobación: {{orderNumber}}',
      summary: 'Se enviará la orden de compra "{{orderNumber}}" a revisión. El estado cambiará de BORRADOR a PENDIENTE_APROBACIÓN.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.reject
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.reject',
    entity: 'PurchaseOrder',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'medium',
    service: 'purchaseOrderWorkflowService',
    method: 'rejectPurchaseOrder',
    description: 'Rechaza una orden de compra en estado PENDIENTE_APROBACIÓN con motivo',
    examples: [
      'Rechaza la orden PO20260321-001, el precio es muy alto',
      'denegar orden de Distribuidora López, motivo: excede presupuesto',
      'reject orden de compra de Lácteos del Norte, proveedor no autorizado',
      'no aprobar el pedido PO2026032-002, requiere más cotizaciones',
      'rechazar la orden de Carnes Premium por precios incorrectos',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál orden de compra quieres rechazar? (número de orden o nombre del proveedor)',
      },
      reason: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el motivo del rechazo?',
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
      return purchaseOrderWorkflowService.rejectPurchaseOrder(
        context.venueId,
        entityId as string,
        (reason as string) || 'Rechazada por el administrador',
        context.userId,
      )
    },
    previewTemplate: {
      title: 'Rechazar orden de compra: {{orderNumber}}',
      summary:
        'Se rechazará la orden de compra "{{orderNumber}}". El estado cambiará a RECHAZADO y la orden volverá al creador para corrección.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.receiveAll
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.receiveAll',
    entity: 'PurchaseOrder',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'medium',
    service: 'purchaseOrderService',
    method: 'receiveAllItems',
    description: 'Registra la recepción completa de todos los artículos de una orden de compra a cantidad ordenada',
    examples: [
      'Llegó todo el pedido PO20260321-001, recíbelo completo',
      'marcar como recibida completamente la orden de Distribuidora López',
      'receive all orden de Carnes Premium, llegó todo',
      'registrar recepción total de la orden PO2026032-002',
      'la orden de Lácteos del Norte llegó al 100%, recíbela',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál orden de compra se recibió completa? (número de orden o nombre del proveedor)',
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
      return purchaseOrderService.receiveAllItems(
        context.venueId,
        entityId as string,
        { receivedDate: new Date().toISOString() },
        context.userId,
      )
    },
    previewTemplate: {
      title: 'Recibir todo: {{orderNumber}}',
      summary:
        'Se registrará la recepción completa de la orden "{{orderNumber}}". Todos los artículos se recibirán a su cantidad ordenada y el stock se actualizará automáticamente.',
      showDiff: false,
      showImpact: true,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.receiveNone
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.receiveNone',
    entity: 'PurchaseOrder',
    operation: 'custom',
    permission: 'inventory:delete',
    dangerLevel: 'high',
    service: 'purchaseOrderService',
    method: 'receiveNoItems',
    description: 'Marca todos los artículos de una orden de compra como no recibidos y cancela la orden',
    examples: [
      'El proveedor no entregó nada, marca la orden PO20260321-001 como no recibida',
      'receiveNone orden de Distribuidora López, no llegó el pedido',
      'cancelar recepción de la orden de Carnes Premium, devolvieron todo',
      'ningún artículo llegó de la orden PO2026032-002, motivo: proveedor no encontrado',
      'no se recibió nada de Lácteos del Norte, marcar sin recepción',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál orden de compra no se recibió? (número de orden o nombre del proveedor)',
      },
      reason: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el motivo por el que no se recibió la mercancía? (opcional)',
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
      return purchaseOrderService.receiveNoItems(context.venueId, entityId as string, {
        reason: reason as string | undefined,
      })
    },
    previewTemplate: {
      title: 'Sin recepción: {{orderNumber}}',
      summary:
        'Se marcará la orden "{{orderNumber}}" como no recibida. Todos los artículos quedarán en estado NO_PROCESADO y la orden se cancelará.',
      showDiff: false,
      showImpact: true,
    },
  },

  // ---------------------------------------------------------------------------
  // inventory.purchaseOrder.delete
  // ---------------------------------------------------------------------------
  {
    actionType: 'inventory.purchaseOrder.delete',
    entity: 'PurchaseOrder',
    operation: 'delete',
    permission: 'inventory:delete',
    dangerLevel: 'high',
    service: 'purchaseOrderService',
    method: 'deletePurchaseOrder',
    description: 'Elimina permanentemente una orden de compra en estado BORRADOR. No funciona en otros estados.',
    examples: [
      'Borra la orden de compra PO20260321-001, estaba en borrador',
      'elimina el borrador de orden de Distribuidora López',
      'delete orden PO2026032-002, era un borrador de prueba',
      'borrar orden de compra de Carnes Premium que está en draft',
      'elimina el pedido borrador de Lácteos del Norte',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿Cuál orden de compra (BORRADOR) quieres eliminar? (número de orden o nombre del proveedor)',
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
      return purchaseOrderService.deletePurchaseOrder(context.venueId, entityId as string)
    },
    previewTemplate: {
      title: 'Eliminar orden de compra: {{orderNumber}}',
      summary:
        'Se eliminará permanentemente la orden de compra "{{orderNumber}}". Solo funciona si está en estado BORRADOR. Esta acción no puede deshacerse.',
      showDiff: false,
      showImpact: true,
    },
  },
]
