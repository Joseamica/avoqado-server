import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { planGateMessage } from '../planGate'
import { getInboxOrder, listInbox } from '@/services/online-ordering/inbox.service'
import { getOnlineMenuSummary, listOnlineMenuProducts } from '@/services/online-ordering/menuAdmin.service'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'
import { getAcceptingStatus, storeView } from '@/services/online-ordering/presence.service'
import { getSettings, pauseOnlineOrdering, storeRequirements, updateSettings } from '@/services/online-ordering/settings.service'
import {
  acceptOnlineOrder,
  cancelOnlineOrderByStaff,
  markOnlineOrderDelivered,
  markOnlineOrderReady,
  rejectOnlineOrder,
  type TransitionResult,
} from '@/services/online-ordering/transitions.service'
import {
  acceptSchema,
  activeCursor,
  floorPauseMinutes,
  menuAvailabilityBody,
  menuCategoryId,
  menuCursor,
  rejectSchema,
  settingsPatchBody,
} from '@/schemas/online-ordering.schema'

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
/** ACEPTAR arma su efecto con los minutos (M-13). */
const EFFECT: Record<Exclude<Action, 'ACCEPT'>, string> = {
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
      cursor: activeCursor
        .optional()
        .describe('Sólo con status=active: el nextCursor de la respuesta anterior, para ver los siguientes pedidos activos'),
    },
    async ({ venueId, status, cursor }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:read', venueId)
      // A8: los activos siguen por llave estable; el cursor no aplica a las demás listas.
      if (cursor && status !== 'active') {
        return text({ ok: false, error: 'El cursor sólo sirve para los pedidos activos (status=active).' })
      }
      const inbox = await listInbox({ venueId, filter: status ?? 'all', ...(cursor ? { activeCursor: cursor } : {}) })
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
      // M-13: el MISMO Zod de la API (trim y mensajes en español).
      estimatedMinutes: acceptSchema.shape.body.shape.estimatedMinutes.describe('Sólo al aceptar: minutos para tenerlo listo'),
      reason: rejectSchema.shape.body.shape.reason.optional().describe('Obligatorio al rechazar'),
      note: rejectSchema.shape.body.shape.note.describe('Sólo al rechazar: nota del motivo'),
      confirm: z.boolean().optional().describe('true para ejecutar de verdad'),
    },
    async ({ venueId, orderId, action, estimatedMinutes, reason, note, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission(PERMISSION[action], venueId)
      requireWriteScopeAlways(scope, PERMISSION[action], 'atiende un pedido en línea y le avisa al comensal')

      if (action === 'REJECT' && !reason) {
        return text({ ok: false, error: 'Para rechazar indica el motivo: OUT_OF_ITEMS, CLOSED, TOO_BUSY u OTHER.' })
      }

      // A8 (P1-08): el pedido se busca DIRECTO en el negocio por su id, nunca dentro de una página de la bandeja (con más de 100
      // activos el más viejo no aparecería).
      const order = await getInboxOrder({ venueId, orderId })
      if (!order) return text({ ok: false, error: 'Ese pedido no existe en este negocio.' })
      // A12: entregar lo que ya está entregado es éxito; no se ejecuta ni se audita nada.
      if (action === 'DELIVERED' && order.status === 'COMPLETED') {
        return text({ ok: true, status: order.status, estimatedReadyAt: null, sinCambios: true, mensaje: 'El pedido ya estaba entregado.' })
      }
      const pendingAction = action === 'ACCEPT' || action === 'REJECT'
      const vigente: string[] = pendingAction ? ['PENDING_ACCEPTANCE'] : ['ACCEPTED', 'READY']
      if (!vigente.includes(order.status)) {
        return text({
          ok: false,
          status: order.status,
          error: pendingAction
            ? 'Ese pedido ya no está por aceptar; no se aplicó nada.'
            : 'Ese pedido no está en preparación ni listo; no se aplicó nada.',
        })
      }

      if (!confirm) {
        // M-13: la vista previa dice lo que se le va a avisar al comensal: los minutos al aceptar, el motivo al rechazar.
        const minutos = action === 'ACCEPT' ? (estimatedMinutes ?? (await getSettings(venueId)).defaultPrepMinutes) : null
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            accion: LABEL[action],
            pedido: order.orderNumber,
            cliente: order.customerName,
            total: order.total,
            platillos: order.items.map(i => `${i.quantity} × ${i.name}`),
            ...(action === 'ACCEPT' ? { minutos } : {}),
            ...(action === 'REJECT' ? { motivo: reason, nota: note || null } : {}),
            efecto:
              action === 'ACCEPT'
                ? `El pedido pasa a preparación y se le avisa al comensal que estará listo en unos ${minutos} minutos.`
                : EFFECT[action],
          },
          mensaje: 'Vuelve a llamar con confirm:true para aplicarlo.',
        })
      }

      const staffId = scope.staffId
      const result =
        action === 'ACCEPT'
          ? await acceptOnlineOrder({ venueId, orderId, staffId, estimatedMinutes })
          : action === 'REJECT'
            ? await rejectOnlineOrder({ venueId, orderId, staffId, reason: reason!, note: note || null })
            : action === 'READY'
              ? await markOnlineOrderReady({ venueId, orderId, staffId })
              : action === 'DELIVERED'
                ? await markOnlineOrderDelivered({ venueId, orderId, staffId })
                : await cancelOnlineOrderByStaff({ venueId, orderId, staffId })

      if (result.outcome !== 'OK') return text(fallo(result))
      // A12: ya estaba entregado (se entregó solo entre la vista previa y la confirmación): éxito sin otra bitácora.
      if (result.unchanged) {
        return text({
          ok: true,
          status: result.status,
          estimatedReadyAt: null,
          sinCambios: true,
          mensaje: 'El pedido ya estaba entregado.',
        })
      }

      await auditMcpWrite(scope, {
        action: AUDIT[action],
        entity: 'OnlineOrder',
        entityId: order.onlineOrderId, // M-13: el id de la entidad que se audita, no el de la cuenta
        venueId,
        data: { pedido: order.orderNumber, reason: reason ?? null, estimatedMinutes: estimatedMinutes ?? null },
      })
      return text({ ok: true, status: result.status, estimatedReadyAt: result.estimatedReadyAt ?? null })
    },
  )

  server.tool(
    'online_ordering_settings',
    'Ajustes de la tienda en línea del negocio, sólo lectura: si está encendida, horario, pedido mínimo en pesos, minutos de preparación, pausas, cuándo consultó la bandeja un aparato por última vez, si la tienda está abierta ahora (y por qué no) y qué le falta para poder encenderla (domicilio, teléfono, aviso de privacidad publicado).',
    { venueId: z.string().describe('Venue (debe estar en tu scope)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:read', venueId)
      // Lo mismo que `GET /settings` del panel: los ajustes se leen una vez y el estado sale del mismo cálculo que la tienda.
      const settings = await getSettings(venueId)
      const [state, requirements] = await Promise.all([getAcceptingStatus(venueId, new Date(), settings), storeRequirements(venueId)])
      const { lastInboxPollAt, ...ajustes } = settings
      return text({
        ok: true,
        ajustes: { ...ajustes, ultimoSondeoDeBandeja: lastInboxPollAt ? lastInboxPollAt.toISOString() : null },
        store: storeView(state),
        requirements,
      })
    },
  )

  server.tool(
    'online_ordering_menu',
    'Menú de la tienda en línea, sólo lectura. Sin categoryId: por categoría, cuántos platillos se podrían vender en línea, cuántos ya se ofrecen y cuántos de ésos no tienen foto. Con categoryId: los platillos de esa categoría (precio en pesos, si están activos y si se ofrecen en línea), por páginas con cursor.',
    {
      venueId: z.string().describe('Venue (debe estar en tu scope)'),
      categoryId: menuCategoryId.optional().describe('Categoría cuyos platillos quieres ver; sin ella, el resumen por categoría'),
      cursor: menuCursor.optional().describe('Sólo con categoryId: el nextCursor de la respuesta anterior, para la página siguiente'),
      limit: z.number().int().min(1).max(50).optional().describe('Platillos por página (1 a 50; 50 por omisión)'),
    },
    async ({ venueId, categoryId, cursor, limit }) => {
      guard.venueFilter(venueId)
      // Es lectura aunque el permiso sea `:manage`: sin 'read' el guardia pediría el scope de escritura.
      guard.requirePermission('online-orders:manage', venueId, 'read')
      if (!categoryId) {
        if (cursor) return text({ ok: false, error: 'El cursor sólo sirve con una categoría (categoryId).' })
        return text({ ok: true, ...(await getOnlineMenuSummary(venueId)) })
      }
      return text({ ok: true, ...(await listOnlineMenuProducts({ venueId, categoryId, cursor, limit })) })
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
