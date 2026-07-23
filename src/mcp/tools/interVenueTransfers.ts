import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { InterVenueTransferMode, InterVenueTransferStatus, InterVenueTransferVarianceReason } from '@prisma/client'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { auditMcpWrite } from '../audit'
import {
  approveInterVenueTransfer,
  cancelInterVenueTransfer,
  createInterVenueTransfer,
  dispatchInterVenueTransfer,
  getInterVenueTransfer,
  listInterVenueTransfers,
  receiveInterVenueTransfer,
  rejectInterVenueTransfer,
  resolveInterVenueTransferVariance,
} from '@/services/dashboard/interVenueTransfer.service'

const itemQuantity = z.object({ itemId: z.string(), quantity: z.number().positive() })
const dispatchItemQuantity = itemQuantity.extend({
  shortfallReason: z.string().min(3).optional().describe('Obligatorio cuando quantity es menor que la cantidad solicitada'),
})
const idempotencyKey = z.string().uuid().describe('UUID estable para reintentar exactamente la misma operación sin duplicarla')

export function registerInterVenueTransferTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  async function inventoryGate(venueId: string) {
    return planGateMessage(venueId, 'INVENTORY_TRACKING', 'El control de inventario')
  }

  server.tool(
    'list_inter_venue_transfers',
    'Lista los traslados de materias primas donde el local indicado es origen o destino. Usa este flujo nuevo; no confundir con los traslados legacy ni con inventario serializado.',
    {
      venueId: z.string(),
      status: z.nativeEnum(InterVenueTransferStatus).optional(),
      direction: z.enum(['incoming', 'outgoing']).optional(),
      search: z.string().optional(),
      page: z.number().int().positive().optional(),
      pageSize: z.number().int().positive().max(100).optional(),
    },
    async ({ venueId, ...filters }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:read', venueId)
      const gate = await inventoryGate(venueId)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      return text({ ok: true, ...(await listInterVenueTransfers(venueId, filters)) })
    },
  )

  server.tool(
    'inter_venue_transfer_detail',
    'Obtiene el detalle, asignaciones FIFO, recepciones parciales y diferencias de un traslado entre sucursales.',
    { venueId: z.string(), transferId: z.string() },
    async ({ venueId, transferId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:read', venueId)
      const gate = await inventoryGate(venueId)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      return text({ ok: true, transfer: await getInterVenueTransfer(venueId, transferId) })
    },
  )

  server.tool(
    'create_inter_venue_transfer',
    'Crea una solicitud PULL desde el destino o un envío PUSH desde el origen. Los IDs de insumo origen/destino deben venir de datos reales; nunca los adivines.',
    {
      venueId: z.string().describe('Contexto que crea: destino para PULL, origen para PUSH'),
      mode: z.nativeEnum(InterVenueTransferMode),
      sourceVenueId: z.string(),
      destinationVenueId: z.string(),
      externalReference: z.string().optional(),
      notes: z.string().optional(),
      items: z
        .array(
          z.object({
            sourceRawMaterialId: z.string(),
            destinationRawMaterialId: z.string(),
            quantity: z.number().positive(),
            notes: z.string().optional(),
          }),
        )
        .min(1),
    },
    async ({ venueId, ...input }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:request', venueId)
      const gate = await inventoryGate(venueId)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const transfer = await createInterVenueTransfer(venueId, input, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'MCP_INTER_VENUE_TRANSFER_CREATED',
        entity: 'InterVenueTransfer',
        entityId: transfer.id,
        venueId,
        data: { mode: input.mode, sourceVenueId: input.sourceVenueId, destinationVenueId: input.destinationVenueId },
      })
      return text({ ok: true, transfer })
    },
  )

  server.tool(
    'approve_inter_venue_transfer',
    'Aprueba desde la sucursal de origen una solicitud PULL pendiente.',
    { venueId: z.string(), transferId: z.string() },
    async ({ venueId, transferId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:approve', venueId)
      const gate = await inventoryGate(venueId)
      if (gate) return text({ ok: false, planRequired: true, error: gate })
      const transfer = await approveInterVenueTransfer(venueId, transferId, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'MCP_INTER_VENUE_TRANSFER_APPROVED',
        entity: 'InterVenueTransfer',
        entityId: transferId,
        venueId,
      })
      return text({ ok: true, transfer })
    },
  )

  server.tool(
    'reject_inter_venue_transfer',
    'Rechaza desde la sucursal de origen una solicitud PULL pendiente; requiere motivo.',
    { venueId: z.string(), transferId: z.string(), reason: z.string().min(3) },
    async ({ venueId, transferId, reason }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:approve', venueId)
      const transfer = await rejectInterVenueTransfer(venueId, transferId, reason, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'MCP_INTER_VENUE_TRANSFER_REJECTED',
        entity: 'InterVenueTransfer',
        entityId: transferId,
        venueId,
        data: { reason },
      })
      return text({ ok: true, transfer })
    },
  )

  server.tool(
    'cancel_inter_venue_transfer',
    'Cancela un traslado antes de la salida. No revierte una salida ya realizada.',
    { venueId: z.string(), transferId: z.string(), reason: z.string().min(3) },
    async ({ venueId, transferId, reason }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:read', venueId)
      const current = await getInterVenueTransfer(venueId, transferId)
      guard.requirePermission(current.sourceVenueId === venueId ? 'inventory-transfers:approve' : 'inventory-transfers:request', venueId)
      const transfer = await cancelInterVenueTransfer(venueId, transferId, reason, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'MCP_INTER_VENUE_TRANSFER_CANCELLED',
        entity: 'InterVenueTransfer',
        entityId: transferId,
        venueId,
        data: { reason },
      })
      return text({ ok: true, transfer })
    },
  )

  server.tool(
    'dispatch_inter_venue_transfer',
    'ALTO IMPACTO: descuenta inventario FIFO del origen y congela costo/caducidad por lote. Por defecto solo previsualiza; confirma con confirm:true.',
    {
      venueId: z.string(),
      transferId: z.string(),
      idempotencyKey,
      items: z.array(dispatchItemQuantity),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, transferId, idempotencyKey: key, items, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:dispatch', venueId)
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: { transferId, action: 'DISPATCH', items },
          message: 'Esto descontará inventario FIFO de la sucursal de origen. Confirma con el operador y repite con confirm:true.',
        })
      }
      const transfer = await dispatchInterVenueTransfer(venueId, transferId, { idempotencyKey: key, items }, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'MCP_INTER_VENUE_TRANSFER_DISPATCHED',
        entity: 'InterVenueTransfer',
        entityId: transferId,
        venueId,
        data: { idempotencyKey: key },
      })
      return text({ ok: true, transfer })
    },
  )

  server.tool(
    'receive_inter_venue_transfer',
    'ALTO IMPACTO: incrementa inventario del destino y crea/actualiza lotes conservando costo y caducidad. Admite recepciones parciales. Por defecto solo previsualiza.',
    {
      venueId: z.string(),
      transferId: z.string(),
      idempotencyKey,
      notes: z.string().optional(),
      items: z.array(itemQuantity),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, transferId, idempotencyKey: key, notes, items, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:receive', venueId)
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: { transferId, action: 'RECEIVE', items },
          message: 'Esto incrementará inventario en la sucursal de destino. Confirma con el operador y repite con confirm:true.',
        })
      }
      const transfer = await receiveInterVenueTransfer(venueId, transferId, { idempotencyKey: key, notes, items }, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'MCP_INTER_VENUE_TRANSFER_RECEIVED',
        entity: 'InterVenueTransfer',
        entityId: transferId,
        venueId,
        data: { idempotencyKey: key },
      })
      return text({ ok: true, transfer })
    },
  )

  server.tool(
    'resolve_inter_venue_transfer_variance',
    'ALTO IMPACTO: clasifica y cierra diferencias explícitas; no las convierte automáticamente en merma. Por defecto solo previsualiza.',
    {
      venueId: z.string(),
      transferId: z.string(),
      idempotencyKey,
      notes: z.string().optional(),
      items: z.array(
        z.object({
          itemId: z.string(),
          quantity: z.number().positive(),
          reason: z.nativeEnum(InterVenueTransferVarianceReason),
          notes: z.string().optional(),
        }),
      ),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, transferId, idempotencyKey: key, notes, items, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('inventory-transfers:receive', venueId)
      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          change: { transferId, action: 'RESOLVE_VARIANCE', items },
          message: 'Esto cerrará diferencias con los motivos indicados. Confirma con el operador y repite con confirm:true.',
        })
      }
      const transfer = await resolveInterVenueTransferVariance(venueId, transferId, { idempotencyKey: key, notes, items }, scope.staffId)
      await auditMcpWrite(scope, {
        action: 'MCP_INTER_VENUE_TRANSFER_VARIANCE_RESOLVED',
        entity: 'InterVenueTransfer',
        entityId: transferId,
        venueId,
        data: { idempotencyKey: key },
      })
      return text({ ok: true, transfer })
    },
  )
}
