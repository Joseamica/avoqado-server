import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { planGateMessage } from '../planGate'
import { listInbox } from '@/services/online-ordering/inbox.service'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'
import { getSettings, pauseOnlineOrdering, updateSettings } from '@/services/online-ordering/settings.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByStaff,
  markOnlineOrderDelivered,
  markOnlineOrderReady,
  rejectOnlineOrder,
  type TransitionResult,
} from '@/services/online-ordering/transitions.service'
import { floorPauseMinutes, menuAvailabilityBody, settingsPatchBody } from '@/schemas/online-ordering.schema'

const GATE_LABEL = 'Los pedidos en línea'

type Action = 'ACCEPT' | 'REJECT' | 'READY' | 'DELIVERED' | 'CANCEL'
/** R15: cancelar pide el permiso de la terminal; lo demás, el que ya usa la bandeja. */
const PERMISSION: Record<Action, string> = {
  ACCEPT: 'orders:update',
  REJECT: 'orders:update',
  READY: 'orders:update',
  DELIVERED: 'orders:update',
  CANCEL: 'orders:cancel-unpaid',
}
const LABEL: Record<Action, string> = { ACCEPT: 'ACEPTAR', REJECT: 'RECHAZAR', READY: 'LISTO', DELIVERED: 'ENTREGADO', CANCEL: 'CANCELAR' }
const EFFECT: Record<Action, string> = {
  ACCEPT: 'El pedido pasa a preparación y se le avisa al comensal cuándo estará listo.',
  REJECT: 'El pedido se cancela y se le avisa al comensal que no se le cobró nada.',
  READY: 'Se le avisa al comensal que su pedido está listo para recoger.',
  DELIVERED: 'El pedido queda entregado. Debe estar cobrado antes.',
  CANCEL: 'La cuenta se cancela (sólo si no tiene cobros) y se le avisa al comensal.',
}
const AUDIT: Record<Action, string> = {
  ACCEPT: 'ONLINE_ORDER_ACCEPTED_VIA_MCP',
  REJECT: 'ONLINE_ORDER_REJECTED_VIA_MCP',
  READY: 'ONLINE_ORDER_READY_VIA_MCP',
  DELIVERED: 'ONLINE_ORDER_COLLECTED_VIA_MCP',
  CANCEL: 'ONLINE_ORDER_CANCELLED_VIA_MCP',
}

/** El texto del cobro (HAS_PAYMENTS) es el mismo de la API del restaurante (`onlineOrders.mobile.controller.ts`). */
function fallo(r: Exclude<TransitionResult, { outcome: 'OK' }>) {
  switch (r.outcome) {
    case 'STALE':
      return { ok: false, status: r.status, error: 'El pedido ya cambió de estado; no se aplicó nada. Vuelve a consultar la bandeja.' }
    case 'PAYMENT_REQUIRED':
      return { ok: false, code: 'PAYMENT_REQUIRED', error: 'Cobra el pedido antes de marcarlo entregado.' }
    case 'HAS_PAYMENTS':
      return {
        ok: false,
        code: 'ORDER_HAS_PAYMENTS',
        error:
          'El pedido ya tiene un cobro, o uno en curso en la terminal. Espera a que termine; si ya se cobró, usa el reembolso de la cuenta.',
      }
    case 'NOT_FOUND':
      return { ok: false, error: 'Ese pedido no existe en este negocio.' }
    default:
      // Un resultado desconocido es un error del servidor, nunca un «no existe» que engañe al dueño.
      throw new Error(`Resultado de transición desconocido: ${String((r as { outcome?: unknown }).outcome)}`)
  }
}

/**
 * Pedidos en línea del negocio (la tienda web del restaurante). 🔴 Responder un pedido y pausar avisan al comensal o cambian
 * lo que ve la tienda: van de DOS pasos con vista previa. Consultar aquí NO cuenta como «aparato conectado»: sólo la bandeja
 * abierta de una app o del panel mantiene la tienda abierta.
 */
export function registerOnlineOrderingTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'online_orders_list',
    'Pedidos en línea del negocio (los que el comensal hace desde la página del restaurante): por aceptar, en preparación, listos y los de las últimas 24 horas. Muestra cliente, platillos, total en pesos y si ya se cobró.',
    {
      venueId: z.string().describe('Venue a consultar (debe estar en tu scope)'),
      status: z
        .enum(['pending', 'active', 'done', 'all'])
        .optional()
        .describe('pending = por aceptar · active = en preparación o listos · done = cerrados · all (default)'),
    },
    async ({ venueId, status }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:read', venueId)
      const inbox = await listInbox({ venueId, filter: status ?? 'all' })
      return text({ ok: true, ...inbox })
    },
  )

  server.tool(
    'online_order_respond',
    'Atiende un pedido en línea: aceptarlo (con minutos estimados), rechazarlo (con motivo: OUT_OF_ITEMS, CLOSED, TOO_BUSY u OTHER), marcarlo listo, entregado o cancelarlo. Salvo al entregar, se le avisa al comensal. Sin confirm:true sólo muestra qué pasaría.',
    {
      venueId: z.string().describe('Venue del pedido (debe estar en tu scope)'),
      orderId: z.string().describe('Id del pedido (orderId de la lista de pedidos en línea)'),
      action: z.enum(['ACCEPT', 'REJECT', 'READY', 'DELIVERED', 'CANCEL']),
      estimatedMinutes: z.number().int().min(1).max(240).optional().describe('Sólo al aceptar: minutos para tenerlo listo'),
      reason: z.enum(['OUT_OF_ITEMS', 'CLOSED', 'TOO_BUSY', 'OTHER']).optional().describe('Obligatorio al rechazar'),
      note: z.string().max(200).optional(),
      confirm: z.boolean().optional().describe('true para ejecutar de verdad'),
    },
    async ({ venueId, orderId, action, estimatedMinutes, reason, note, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission(PERMISSION[action], venueId)
      requireWriteScopeAlways(scope, PERMISSION[action], 'atiende un pedido en línea y le avisa al comensal')

      if (action === 'REJECT' && !reason) {
        return text({ ok: false, error: 'Para rechazar indica el motivo: OUT_OF_ITEMS, CLOSED, TOO_BUSY u OTHER.' })
      }

      const pendingAction = action === 'ACCEPT' || action === 'REJECT'
      const inbox = await listInbox({ venueId, filter: pendingAction ? 'pending' : 'active' })
      const order = inbox.orders.find(o => o.orderId === orderId)
      if (!order) {
        return text({
          ok: false,
          error: pendingAction
            ? 'Ese pedido no está por aceptar (ya cambió o no existe).'
            : 'Ese pedido no está en preparación ni listo (ya cambió o no existe).',
        })
      }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            accion: LABEL[action],
            pedido: order.orderNumber,
            cliente: order.customerName,
            total: order.total,
            platillos: order.items.map(i => `${i.quantity} × ${i.name}`),
            efecto: EFFECT[action],
          },
          mensaje: 'Vuelve a llamar con confirm:true para aplicarlo.',
        })
      }

      const staffId = scope.staffId
      const result =
        action === 'ACCEPT'
          ? await acceptOnlineOrder({ venueId, orderId, staffId, estimatedMinutes })
          : action === 'REJECT'
            ? await rejectOnlineOrder({ venueId, orderId, staffId, reason: reason!, note: note ?? null })
            : action === 'READY'
              ? await markOnlineOrderReady({ venueId, orderId, staffId })
              : action === 'DELIVERED'
                ? await markOnlineOrderDelivered({ venueId, orderId, staffId })
                : await cancelOnlineOrderByStaff({ venueId, orderId, staffId })

      if (result.outcome !== 'OK') return text(fallo(result))

      await auditMcpWrite(scope, {
        action: AUDIT[action],
        entity: 'OnlineOrder',
        entityId: orderId,
        venueId,
        data: { pedido: order.orderNumber, reason: reason ?? null, estimatedMinutes: estimatedMinutes ?? null },
      })
      return text({ ok: true, status: result.status, estimatedReadyAt: result.estimatedReadyAt ?? null })
    },
  )

  server.tool(
    'online_ordering_settings',
    'Ajustes de la tienda en línea del negocio, sólo lectura: si está encendida, horario, pedido mínimo en pesos, minutos de preparación, pausas y cuándo consultó la bandeja un aparato por última vez.',
    { venueId: z.string().describe('Venue (debe estar en tu scope)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:read', venueId)
      const { lastInboxPollAt, ...ajustes } = await getSettings(venueId)
      return text({ ok: true, ajustes: { ...ajustes, ultimoSondeoDeBandeja: lastInboxPollAt ? lastInboxPollAt.toISOString() : null } })
    },
  )

  server.tool(
    'online_ordering_configure',
    'Cambia la tienda en línea del negocio: encendido, horario, pedido mínimo en pesos, minutos de preparación, pausa del gerente y qué platillos se ofrecen en línea. Muestra «de → a» y exige confirm:true.',
    {
      venueId: z.string().describe('Venue (debe estar en tu scope)'),
      changes: settingsPatchBody.optional().describe('Ajustes a cambiar, con las mismas reglas que el panel'),
      availability: menuAvailabilityBody.optional().describe('Marcar o desmarcar platillos (por ids, categorías o todo el menú)'),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, changes, availability, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('online-orders:manage', venueId)
      requireWriteScopeAlways(scope, 'online-orders:manage', 'cambia la tienda en línea del negocio')
      const gate = await planGateMessage(venueId, 'ONLINE_ORDERING', GATE_LABEL)
      if (gate) return text({ ok: false, planRequired: true, feature: 'ONLINE_ORDERING', error: gate })

      const hasChanges = !!changes && Object.keys(changes).length > 0
      if (!hasChanges && !availability) {
        return text({ ok: false, error: 'Indica qué cambiar: los ajustes (changes) o los platillos en línea (availability).' })
      }

      const { lastInboxPollAt: _latido, ...current } = await getSettings(venueId)
      const actual = current as Record<string, unknown>
      const diff = Object.entries(changes ?? {})
        .filter(([campo, valor]) => JSON.stringify(actual[campo]) !== JSON.stringify(valor))
        .map(([campo, a]) => ({ campo, de: actual[campo], a }))
      if (diff.length === 0 && !availability) return text({ ok: true, sinCambios: true, ajustes: current })

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { negocio: venueId, cambios: diff, platillosEnLinea: availability ?? null },
          mensaje: 'Vuelve a llamar con confirm:true para aplicarlo. Los cambios se ven de inmediato en la tienda pública.',
        })
      }

      const ajustes = diff.length > 0 ? await updateSettings(venueId, changes!, scope.staffId) : current
      const platillos = availability ? await setOnlineAvailability({ venueId, ...availability, actorStaffId: scope.staffId }) : null
      await auditMcpWrite(scope, {
        action: 'ONLINE_ORDERING_CONFIGURED_VIA_MCP',
        entity: 'OnlineOrderingSettings',
        entityId: venueId,
        venueId,
        data: { cambios: diff, platillosEnLinea: availability ?? null },
      })
      return text({ ok: true, ajustes, platillosActualizados: platillos?.updated ?? 0 })
    },
  )

  server.tool(
    'online_ordering_pause',
    'Frena la tienda en línea 15, 30 o 60 minutos (por ejemplo en hora pico) o la reanuda con minutes: null. Los pedidos ya recibidos no cambian. Sin confirm:true sólo muestra qué pasaría.',
    {
      venueId: z.string().describe('Venue (debe estar en tu scope)'),
      minutes: floorPauseMinutes.describe('15, 30 o 60 para pausar; null para reanudar'),
      confirm: z.boolean().optional(),
    },
    async ({ venueId, minutes, confirm }) => {
      guard.venueFilter(venueId)
      // D7 (founder, 16-oct): pausar tiene su propio permiso. Aquí no hay PIN del gerente: decide el permiso de quien conecta.
      guard.requirePermission('online-orders:pause', venueId)
      requireWriteScopeAlways(scope, 'online-orders:pause', minutes === null ? 'reanuda la tienda en línea' : 'pausa la tienda en línea')

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            accion: minutes === null ? 'REANUDAR' : `PAUSAR ${minutes} MIN`,
            efecto:
              minutes === null
                ? 'La tienda vuelve a recibir pedidos (si está encendida, en horario, sin la pausa del gerente y con una bandeja abierta).'
                : `La tienda deja de recibir pedidos nuevos durante ${minutes} minutos.`,
          },
          mensaje: 'Vuelve a llamar con confirm:true para aplicarlo.',
        })
      }

      const r = await pauseOnlineOrdering(venueId, minutes, scope.staffId)
      await auditMcpWrite(scope, {
        action: minutes === null ? 'ONLINE_ORDERING_RESUMED_VIA_MCP' : 'ONLINE_ORDERING_PAUSED_VIA_MCP',
        entity: 'OnlineOrderingSettings',
        entityId: venueId,
        venueId,
        data: { minutes },
      })
      return text({ ok: true, ...r })
    },
  )
}
