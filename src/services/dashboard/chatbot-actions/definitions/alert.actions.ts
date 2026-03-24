import prisma from '@/utils/prismaClient'
import { ActionDefinition } from '../types'
import * as alertService from '../../alert.service'

// ---------------------------------------------------------------------------
// Helper: resolve active alert by raw material name
// ---------------------------------------------------------------------------
async function resolveAlertByRawMaterialName(
  venueId: string,
  rawMaterialName: string,
): Promise<{ alertId: string; rawMaterialDisplayName: string }> {
  // Try exact/contains match first
  let rawMaterial = await prisma.rawMaterial.findFirst({
    where: {
      venueId,
      deletedAt: null,
      name: { contains: rawMaterialName, mode: 'insensitive' },
    },
    select: { id: true, name: true },
  })

  // Fuzzy fallback via pg_trgm
  if (!rawMaterial) {
    const fuzzy = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name FROM "RawMaterial"
      WHERE "venueId" = ${venueId} AND "deletedAt" IS NULL
        AND similarity(name, ${rawMaterialName}) > 0.2
      ORDER BY similarity(name, ${rawMaterialName}) DESC
      LIMIT 1
    `
    if (fuzzy.length > 0) rawMaterial = fuzzy[0]
  }

  if (!rawMaterial) {
    throw new Error(`No se encontró el insumo "${rawMaterialName}" en el inventario.`)
  }

  // Find the active alert for this raw material
  const alert = await prisma.lowStockAlert.findFirst({
    where: {
      venueId,
      rawMaterialId: rawMaterial.id,
      status: { in: ['ACTIVE', 'ACKNOWLEDGED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })

  if (!alert) {
    throw new Error(`No hay alertas activas para el insumo "${rawMaterial.name}".`)
  }

  return { alertId: alert.id, rawMaterialDisplayName: rawMaterial.name }
}

export const alertActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // alert.acknowledge
  // ---------------------------------------------------------------------------
  {
    actionType: 'alert.acknowledge',
    entity: 'LowStockAlert',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'low',
    service: 'alertService',
    method: 'acknowledgeAlert',
    description: 'Marca una alerta de stock bajo como vista/reconocida sin resolverla',
    examples: [
      'Ya vi la alerta de stock bajo de harina',
      'reconoce la alerta de tomate bola',
      'acknowledge alerta de pollo, ya la vi',
      'marcar como vista la alerta del aceite de oliva',
      'ya sé del stock bajo de queso manchego, marca la alerta',
    ],
    fields: {
      rawMaterialName: {
        type: 'string',
        required: true,
        prompt: '¿Para cuál insumo quieres reconocer la alerta?',
      },
    },
    serviceAdapter: async (params, context) => {
      const rawMaterialName = params.rawMaterialName as string
      const { alertId, rawMaterialDisplayName } = await resolveAlertByRawMaterialName(context.venueId, rawMaterialName)
      const result = await alertService.acknowledgeAlert(context.venueId, alertId, context.userId)
      return { ...result, rawMaterialName: rawMaterialDisplayName }
    },
    previewTemplate: {
      title: 'Reconocer alerta: {{rawMaterialName}}',
      summary: 'Se marcará como reconocida la alerta activa del insumo "{{rawMaterialName}}". El stock bajo sigue pendiente de resolución.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // alert.resolve
  // ---------------------------------------------------------------------------
  {
    actionType: 'alert.resolve',
    entity: 'LowStockAlert',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'low',
    service: 'alertService',
    method: 'resolveAlert',
    description: 'Resuelve manualmente una alerta de stock bajo cuando el stock ya fue reabastecido',
    examples: [
      'Resuelve la alerta de harina, ya llegó el pedido',
      'cierra la alerta de tomate, ya se reabastecio',
      'marcar alerta de pollo como resuelta',
      'ya tenemos suficiente aceite, resuelve la alerta',
      'resolver alerta de stock de sal de grano',
    ],
    fields: {
      rawMaterialName: {
        type: 'string',
        required: true,
        prompt: '¿Para cuál insumo quieres resolver la alerta?',
      },
    },
    serviceAdapter: async (params, context) => {
      const rawMaterialName = params.rawMaterialName as string
      const { alertId, rawMaterialDisplayName } = await resolveAlertByRawMaterialName(context.venueId, rawMaterialName)
      const result = await alertService.resolveAlert(context.venueId, alertId, context.userId)
      return { ...result, rawMaterialName: rawMaterialDisplayName }
    },
    previewTemplate: {
      title: 'Resolver alerta: {{rawMaterialName}}',
      summary: 'Se marcará como resuelta la alerta del insumo "{{rawMaterialName}}". El stock debe estar por encima del punto de reorden.',
      showDiff: false,
      showImpact: false,
    },
  },

  // ---------------------------------------------------------------------------
  // alert.dismiss
  // ---------------------------------------------------------------------------
  {
    actionType: 'alert.dismiss',
    entity: 'LowStockAlert',
    operation: 'custom',
    permission: 'inventory:update',
    dangerLevel: 'low',
    service: 'alertService',
    method: 'dismissAlert',
    description: 'Descarta una alerta de stock bajo sin resolverla (por ejemplo, si es un falso positivo)',
    examples: [
      'Descarta la alerta de harina, es un error',
      'dismiss alerta de tomate, no aplica',
      'ignora la alerta de aceite de ajonjolí',
      'descartar alerta de queso panela, producto en descontinuación',
      'cierra la alerta de sal, motivo: producto reemplazado',
    ],
    fields: {
      rawMaterialName: {
        type: 'string',
        required: true,
        prompt: '¿Para cuál insumo quieres descartar la alerta?',
      },
      reason: {
        type: 'string',
        required: false,
        prompt: '¿Cuál es el motivo para descartar la alerta? (opcional)',
      },
    },
    serviceAdapter: async (params, context) => {
      const rawMaterialName = params.rawMaterialName as string
      const reason = params.reason as string | undefined
      const { alertId, rawMaterialDisplayName } = await resolveAlertByRawMaterialName(context.venueId, rawMaterialName)
      const result = await alertService.dismissAlert(context.venueId, alertId, reason, context.userId)
      return { ...result, rawMaterialName: rawMaterialDisplayName }
    },
    previewTemplate: {
      title: 'Descartar alerta: {{rawMaterialName}}',
      summary: 'Se descartará la alerta del insumo "{{rawMaterialName}}". Esta acción no resuelve el problema de stock subyacente.',
      showDiff: false,
      showImpact: false,
    },
  },
]
