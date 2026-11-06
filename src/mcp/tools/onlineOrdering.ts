import { createHash } from 'crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import AppError from '@/errors/AppError'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { CONFIRMATION_TTL, issueConfirmation, validConfirmation } from '../confirmation'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import { planGateMessage } from '../planGate'
import { getInboxOrder, listInbox } from '@/services/online-ordering/inbox.service'
import { listFolios } from '@/services/online-ordering/folios.service'
import { esVentaCerrada } from '@/services/shared/orderBalance'
import { listCardRefunds, refundCardOnlineOrder, resolveReversedCardRefund } from '@/services/online-ordering/card/refund.service'
import { getOnlineMenuSummary, listOnlineMenuProducts } from '@/services/online-ordering/menuAdmin.service'
import { setOnlineAvailability } from '@/services/online-ordering/menuAvailability.service'
import { getSettings, pauseOnlineOrdering, updateSettings } from '@/services/online-ordering/settings.service'
import { settingsView } from '@/services/online-ordering/settingsView.service'
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

/** El mismo texto de la API (`accept` del controlador móvil): un folio no se prepara sin pago. */
const FOLIO_SIN_PAGAR = 'Este pedido se cobra antes de prepararlo'
/** Rechazos del servicio al guardar los ajustes que se dicen en texto, sin error (nada se escribió). */
const AJUSTES_RECHAZADOS = new Set(['NO_PAYMENT_MODE', 'PAY_AT_PICKUP_REQUIRED', 'HOURS_REQUIRED', 'NO_FOLIO_DEVICE'])

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
    case 'CONFIRMING_PAYMENT':
      return { ok: false, error: 'Confirmando el pago con el banco; vuelve a consultar en unos segundos.' }
    default:
      // Un resultado desconocido es un error del servidor, nunca un «no existe» que engañe al dueño.
      throw new Error(`Resultado de transición desconocido: ${String((r as { outcome?: unknown }).outcome)}`)
  }
}

/** Fase 2: el switch del pago con tarjeta se muestra como lo dice el panel: «Aceptar pago con tarjeta: no → sí». */
const sino = (v: unknown) => (v ? 'sí' : 'no')
const CARD_TOGGLE_LABEL = 'Aceptar pago con tarjeta'

/**
 * Pedidos en línea del negocio (la tienda web del restaurante). 🔴 Responder un pedido y pausar avisan al comensal o cambian
 * lo que ve la tienda: van de DOS pasos con vista previa. Consultar aquí NO cuenta como «aparato conectado»: sólo la bandeja
 * abierta de una app o del panel mantiene la tienda abierta.
 */
export function registerOnlineOrderingTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'online_orders_list',
    'Pedidos en línea del negocio (los que el comensal hace desde la página del restaurante): por aceptar, en preparación, listos y los de las últimas 24 horas. Muestra cliente, platillos, total en pesos y si ya se cobró. Los que el comensal pagó con tarjeta al pedir traen el cobro (estado, monto apartado y monto cobrado, en pesos). Con status=to_pay salen los pedidos de pedir y pagar en caja que aún no se cobran, y con to_deliver los ya cobrados por entregar (cada uno por páginas con cursor).',
    {
      venueId: z.string().describe('Venue a consultar (debe estar en tu scope)'),
      status: z
        .enum(['pending', 'active', 'done', 'all', 'to_pay', 'to_deliver'])
        .optional()
        .describe(
          'pending = por aceptar · active = en preparación o listos · done = cerrados · all (default) · to_pay = por pagar en caja · to_deliver = cobrados por entregar',
        ),
      cursor: activeCursor
        .optional()
        .describe(
          'Sólo con status=active, to_pay o to_deliver: el nextCursor (o nextCursors de esa sección) de la respuesta anterior, para ver los siguientes',
        ),
    },
    async ({ venueId, status, cursor }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:read', venueId)
      // R17: «Por pagar» y «Por entregar» siguen por su propio cursor; nunca se corta en silencio.
      if (status === 'to_pay' || status === 'to_deliver') {
        try {
          const folios = await listFolios({ venueId, section: status === 'to_pay' ? 'toPay' : 'toDeliver', ...(cursor ? { cursor } : {}) })
          return text({ ok: true, ...folios })
        } catch (e) {
          if (e instanceof AppError && e.code === 'INVALID_CURSOR') return text({ ok: false, code: 'INVALID_CURSOR', error: e.message })
          throw e
        }
      }
      // A8: los activos siguen por llave estable; el cursor no aplica a las demás listas.
      if (cursor && status !== 'active') {
        return text({
          ok: false,
          error: 'El cursor sólo sirve para los pedidos activos, por pagar o por entregar (status=active, to_pay o to_deliver).',
        })
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
      // T13: un folio por pagar («Nadie» acepta) también se puede cancelar; uno de «Mi equipo» por aceptar se rechaza, no se cancela.
      const folio = order.requiresAcceptance === false
      const vigente: string[] = pendingAction
        ? ['PENDING_ACCEPTANCE']
        : action === 'CANCEL' && folio
          ? ['PENDING_ACCEPTANCE', 'ACCEPTED', 'READY']
          : ['ACCEPTED', 'READY']
      if (!vigente.includes(order.status)) {
        return text({
          ok: false,
          status: order.status,
          error: pendingAction
            ? 'Ese pedido ya no está por aceptar; no se aplicó nada.'
            : 'Ese pedido no está en preparación ni listo; no se aplicó nada.',
        })
      }

      if (action === 'ACCEPT' && folio && !esVentaCerrada(order.paymentStatus)) {
        return text({ ok: false, code: 'PAYMENT_REQUIRED', error: FOLIO_SIN_PAGAR })
      }

      const tarjeta = order.paymentMode === 'CARD_ONLINE'
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
              (action === 'ACCEPT'
                ? `El pedido pasa a preparación y se le avisa al comensal que estará listo en unos ${minutos} minutos.`
                : EFFECT[action]) +
              // Fase 2: aceptar mueve dinero (se cobra lo apartado) y rechazar lo libera: la vista previa lo dice.
              (tarjeta && action === 'ACCEPT'
                ? ` Se cobra la tarjeta apartada${order.card ? ` ($${order.card.amount.toFixed(2)})` : ''}.`
                : tarjeta && action === 'REJECT'
                  ? ' El dinero apartado en la tarjeta se libera.'
                  : ''),
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

      // Fase 2: aceptar un pedido con tarjeta que no se pudo cobrar lo deja RECHAZADO (y libera lo apartado): el servicio lo
      // contesta como STALE + REJECTED y aquí se dice con todas sus letras.
      if (action === 'ACCEPT' && tarjeta && result.outcome === 'STALE' && result.status === 'REJECTED') {
        return text({
          ok: false,
          status: result.status,
          error: 'No se pudo cobrar la tarjeta; el pedido se rechazó y el dinero apartado se liberó.',
        })
      }
      if (action === 'ACCEPT' && result.outcome === 'PAYMENT_REQUIRED') {
        return text({ ok: false, code: 'PAYMENT_REQUIRED', error: FOLIO_SIN_PAGAR })
      }
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
    'Ajustes de la tienda en línea del negocio, sólo lectura: si está encendida, horario, pedido mínimo en pesos, minutos de preparación, pausas, cuándo consultó la bandeja un aparato por última vez, si la tienda está abierta ahora (y por qué no) y qué le falta para poder encenderla (domicilio, teléfono, aviso de privacidad publicado). También si acepta pago con tarjeta al pedir y si su cuenta de Stripe está lista para cobrar.',
    { venueId: z.string().describe('Venue (debe estar en tu scope)') },
    async ({ venueId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:read', venueId)
      // Lo mismo que `GET /settings` del panel (un solo armador): los ajustes se leen una vez y el estado sale del mismo cálculo.
      // `card` (fase 2) sale aparte, explícito: no se cuela dentro de `ajustes`.
      const { lastInboxPollAt, store, requirements, card, ...ajustes } = await settingsView(venueId)
      return text({ ok: true, ajustes: { ...ajustes, ultimoSondeoDeBandeja: lastInboxPollAt }, store, requirements, card })
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
    'Cambia la tienda en línea del negocio: encendido, horario, pedido mínimo en pesos, minutos de preparación, pausa del gerente, aceptar pago con tarjeta al pedir (acceptsCardOnline; viene prendido y la tienda lo ofrece sólo con la cuenta de Stripe conectada y lista) y qué platillos se ofrecen en línea. Muestra «de → a» y exige confirm:true.',
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

      const settings = await getSettings(venueId)
      const { lastInboxPollAt: _latido, ...current } = settings
      const actual = current as Record<string, unknown>
      const diff = Object.entries(changes ?? {})
        // Un «no quiero tarjeta» explícito se guarda aunque ya estuviera apagada: su bitácora es la que evita que la tarjeta prendida
        // de fábrica (S1b) se la prenda después.
        .filter(
          ([campo, valor]) => JSON.stringify(actual[campo]) !== JSON.stringify(valor) || (campo === 'acceptsCardOnline' && valor === false),
        )
        .map(([campo, a]) => ({
          campo,
          de: actual[campo],
          a,
          ...(campo === 'acceptsCardOnline' ? { resumen: `${CARD_TOGGLE_LABEL}: ${sino(actual[campo])} → ${sino(a)}` } : {}),
        }))
      if (diff.length === 0 && !availability) return text({ ok: true, sinCambios: true, ajustes: current })

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { negocio: venueId, cambios: diff, platillosEnLinea: availability ?? null },
          mensaje: 'Vuelve a llamar con confirm:true para aplicarlo. Los cambios se ven de inmediato en la tienda pública.',
        })
      }

      let actualizados: Awaited<ReturnType<typeof updateSettings>> | null = null
      try {
        actualizados = diff.length > 0 ? await updateSettings(venueId, changes!, scope.staffId) : null
      } catch (e) {
        // A (2-nov): la tienda se quedaría sin cómo cobrar (p. ej. sólo tarjeta y Stripe sin poder cobrar). Nada se escribió: se dice
        // claro, sin error.
        // «Nadie» (requiresAcceptance:false) trae los suyos: pago en caja, horario y un aparato que cobre folios (409).
        if (e instanceof AppError && e.code && AJUSTES_RECHAZADOS.has(e.code)) {
          return text({ ok: false, code: e.code, error: e.message })
        }
        throw e
      }
      const ajustes = actualizados ?? current
      const platillos = availability ? await setOnlineAvailability({ venueId, ...availability, actorStaffId: scope.staffId }) : null
      await auditMcpWrite(scope, {
        action: 'ONLINE_ORDERING_CONFIGURED_VIA_MCP',
        entity: 'OnlineOrderingSettings',
        entityId: venueId,
        venueId,
        data: { cambios: diff, platillosEnLinea: availability ?? null },
      })
      // Lo que quedó: el estado de la tienda y qué le falta para encenderla, del mismo armador que el panel (después de auditar:
      // un fallo al leerlo no deja el cambio sin bitácora).
      const { store, requirements, card } = await settingsView(venueId, actualizados ?? settings)
      return text({ ok: true, ajustes, store, requirements, card, platillosActualizados: platillos?.updated ?? 0 })
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

  // ── Fase 2 (F3, «MCP en sync»): devolver a la tarjeta y «Devolver por otro medio», con los MISMOS servicios del panel ──

  server.tool(
    'online_order_card_refunds',
    'Devoluciones a la tarjeta de un pedido en línea pagado con tarjeta al pedir, sólo lectura: monto en pesos, motivo, estado (REQUESTED, SENDING, PENDING, SUCCEEDED o RECORDED = devuelta y anotada; FAILED o CANCELED = el banco no la hizo; REVERSED = falló después de anotarla y falta devolver por otro medio; RESOLVED = ya se devolvió por otro medio) y, si falló después, el motivo y cómo se resolvió.',
    {
      venueId: z.string().describe('Venue del pedido (debe estar en tu scope)'),
      orderId: z.string().describe('Id del pedido (orderId de la lista de pedidos en línea)'),
    },
    async ({ venueId, orderId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('payments:read', venueId)
      const filas = await listCardRefunds(venueId, orderId)
      // Pesos 1:1 como número (el servicio del panel los da como texto con dos decimales).
      const devoluciones = filas.map(f => ({
        ...f,
        amount: Number(f.amount),
        feeRefunded: f.feeRefunded == null ? null : Number(f.feeRefunded),
      }))
      return text({ ok: true, devoluciones })
    },
  )

  server.tool(
    'online_order_card_refund',
    'Devuelve a la tarjeta del cliente (total o parcial) un pedido en línea que se cobró con tarjeta al pedir. El monto va en pesos (por ejemplo 120.50) y no puede pasar de lo que queda por devolver. Dos pasos: sin confirm:true sólo muestra la vista previa, un confirmationToken y expectedLatestRefundId; para devolver, repite los mismos datos con confirm:true, ese confirmationToken (vale 10 minutos) y ese expectedLatestRefundId. Repetir la confirmación con el mismo token no devuelve dos veces; si hubo otra devolución desde la vista previa contesta CARD_REFUND_STALE_VIEW y hay que revisarla y pedir otra vista previa. Pide permiso para reembolsar.',
    {
      venueId: z.string().describe('Venue del pedido (debe estar en tu scope)'),
      orderId: z.string().describe('Id del pedido (orderId de la lista de pedidos en línea)'),
      amount: z.number().positive().finite().multipleOf(0.01).max(9_999_999.99).describe('Monto a devolver en PESOS, por ejemplo 120.50'),
      reason: z
        .enum(['RETURNED_GOODS', 'ACCIDENTAL_CHARGE', 'CANCELLED_ORDER', 'FRAUDULENT_CHARGE', 'OTHER'])
        .describe('Motivo de la devolución'),
      note: z.string().trim().max(200).optional().describe('Nota para la bitácora'),
      confirm: z.boolean().optional().describe('true para devolver de verdad (con el confirmationToken de la vista previa)'),
      confirmationToken: z.string().optional().describe('El confirmationToken que dio la vista previa'),
      expectedLatestRefundId: z
        .string()
        .nullable()
        .optional()
        .describe('Al confirmar: el expectedLatestRefundId que dio la vista previa, tal cual (la última devolución que se vio)'),
    },
    async ({ venueId, orderId, amount, reason, note, confirm, confirmationToken, expectedLatestRefundId }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('payments:refund', venueId)
      requireWriteScopeAlways(scope, 'payments:refund', 'devuelve dinero a la tarjeta del cliente')
      const monto = new Prisma.Decimal(amount).toDecimalPlaces(2)
      const nota = note || null
      const datos = { venueId, orderId, amount: monto.toFixed(2), reason, note: nota }

      if (!confirm) {
        const order = await getInboxOrder({ venueId, orderId })
        if (!order) return text({ ok: false, error: 'Ese pedido no existe en este negocio.' })
        if (order.paymentMode !== 'CARD_ONLINE' || order.card?.status !== 'CAPTURED') {
          return text({ ok: false, error: 'Este pedido no se cobró con tarjeta en línea; no hay nada que devolver a la tarjeta.' })
        }
        // Lo visto lo fija el servidor al hacer la vista previa y queda atado a la firma: confirmar no puede renovarlo.
        const vista = (await listCardRefunds(venueId, orderId))[0]?.id ?? null
        return text({
          ok: false,
          requiresConfirmation: true,
          expectedLatestRefundId: vista,
          preview: {
            pedido: order.orderNumber,
            cliente: order.customerName,
            cobrado: order.card.capturedAmount,
            devolver: Number(monto.toFixed(2)),
            motivo: reason,
            nota,
            efecto: `Se devuelven $${monto.toFixed(2)} a la tarjeta del cliente.`,
          },
          confirmationToken: issueConfirmation(scope, 'online_order_card_refund', { ...datos, expectedLatestRefundId: vista }),
          mensaje:
            'Confírmalo con la persona y vuelve a llamar con los mismos datos, confirm:true, el confirmationToken y expectedLatestRefundId.',
        })
      }

      const vista = expectedLatestRefundId ?? null
      if (!validConfirmation(confirmationToken, scope, 'online_order_card_refund', { ...datos, expectedLatestRefundId: vista })) {
        return text({
          ok: false,
          error: `La vista previa venció (dura ${CONFIRMATION_TTL / 60} minutos) o estos datos no son los que se vieron (pedido, monto, motivo, nota o expectedLatestRefundId). Pide una vista previa nueva y confírmala tal cual.`,
        })
      }
      // La llave sale de la confirmación: repetir ESTA confirmación es la misma devolución; una vista previa nueva, otra.
      const idempotencyKey = `mcp_${createHash('sha256').update(confirmationToken!).digest('hex').slice(0, 40)}`
      try {
        const r = await refundCardOnlineOrder({
          venueId,
          orderId,
          amount: monto,
          reason,
          staffId: scope.staffId,
          idempotencyKey,
          note: nota,
          expectedLatestRefundId: vista,
        })
        await auditMcpWrite(scope, {
          action: 'ONLINE_ORDER_CARD_REFUND_VIA_MCP',
          entity: 'OnlineOrderCardRefund',
          entityId: r.cardRefundId,
          venueId,
          data: { orderId, amount: monto.toFixed(2), reason, note: nota, status: r.status, replay: r.replay },
        })
        return text({ ok: true, ...r })
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        return text({ ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) })
      }
    },
  )

  server.tool(
    'online_order_card_refund_resolve',
    'Devolver por otro medio: cuando una devolución a la tarjeta falló en el banco después de anotarse (estado REVERSED en online_order_card_refunds), registra que el negocio ya le devolvió ese dinero al cliente en efectivo (sale de la caja abierta) o por transferencia. Dos pasos: sin confirm:true sólo muestra la vista previa. En efectivo pide el permiso de devolver en efectivo; por transferencia, el de reembolsar.',
    {
      venueId: z.string().describe('Venue del pedido (debe estar en tu scope)'),
      orderId: z.string().describe('Id del pedido'),
      refundId: z.string().describe('Id de la devolución (de online_order_card_refunds)'),
      method: z.enum(['CASH', 'BANK_TRANSFER']).describe('CASH = efectivo de la caja abierta · BANK_TRANSFER = transferencia'),
      note: z.string().trim().max(200).optional().describe('Nota para la bitácora'),
      confirm: z.boolean().optional().describe('true para registrarlo de verdad'),
    },
    async ({ venueId, orderId, refundId, method, note, confirm }) => {
      guard.venueFilter(venueId)
      // F2: sacar efectivo del cajón por un cobro de tarjeta pide su propio permiso (como el panel y el POS).
      const permiso = method === 'CASH' ? 'payments:refund-to-cash' : 'payments:refund'
      guard.requirePermission(permiso, venueId)
      requireWriteScopeAlways(scope, permiso, 'registra la devolución de dinero al cliente por otro medio')
      const nota = note || null

      if (!confirm) {
        const fila = (await listCardRefunds(venueId, orderId)).find(f => f.id === refundId)
        if (!fila || fila.status !== 'REVERSED' || fila.reversal?.resolvedAt) {
          return text({ ok: false, error: 'Esta devolución no está pendiente de pagarse por otro medio.' })
        }
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            devolucion: fila.id,
            monto: Number(fila.amount),
            metodo: method,
            nota,
            efecto:
              method === 'CASH'
                ? `Salen $${fila.amount} en efectivo de la caja abierta para devolvérselos al cliente.`
                : `Queda registrado que le devolviste $${fila.amount} al cliente por transferencia.`,
          },
          mensaje: 'Confírmalo con la persona y vuelve a llamar con confirm:true.',
        })
      }

      try {
        const r = await resolveReversedCardRefund({ venueId, orderId, cardRefundId: refundId, method, staffId: scope.staffId, note: nota })
        if (!r.replay) {
          await auditMcpWrite(scope, {
            action: 'ONLINE_ORDER_CARD_REFUND_RESOLVED_VIA_MCP',
            entity: 'OnlineOrderCardRefund',
            entityId: refundId,
            venueId,
            data: { orderId, method, note: nota },
          })
        }
        return text({ ok: true, ...r })
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        return text({ ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) })
      }
    },
  )
}
