import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { OrderStatus, OrderType, PaymentStatus, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { venueStartOfDay, venueEndOfDay } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { getRecentIntents } from '@/services/mobile/sync.mobile.service'
import { text } from '../respond'
import { hasPermission } from '@/services/access/access.service'
// El carril del reembolso: la MISMA definición que usan los cuatro canales de
// cobro, para que el MCP no pueda contradecir al saldo persistido.
import { summarizeRefunds } from '@/services/shared/orderBalance'

const num = (d: { toString(): string } | null): number => (d == null ? 0 : Number(d))
const ORDER_STATUS_MAP: Record<string, OrderStatus> = {
  pending: OrderStatus.PENDING,
  confirmed: OrderStatus.CONFIRMED,
  preparing: OrderStatus.PREPARING,
  ready: OrderStatus.READY,
  completed: OrderStatus.COMPLETED,
  cancelled: OrderStatus.CANCELLED,
  deleted: OrderStatus.DELETED,
}
const ORDER_TYPE_MAP: Record<string, OrderType> = {
  dine_in: OrderType.DINE_IN,
  takeout: OrderType.TAKEOUT,
  delivery: OrderType.DELIVERY,
  pickup: OrderType.PICKUP,
  manual_entry: OrderType.MANUAL_ENTRY,
}

export function registerOrderTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  // WHY: order tools expose money (totals, line items, per-payment amounts). The dashboard
  // gates order reads with orders:read; the MCP was only venue-scoped, so any in-scope role
  // (KITCHEN/HOST/VIEWER) could read revenue the dashboard 403s. Mirror daily_sales:
  //   - single venue  → hard-deny if the role lacks orders:read (venueFilter still validates scope);
  //   - all venues     → restrict to the venues where the caller actually holds orders:read,
  //     so a low-role staffer can't reconstruct org-wide revenue via search_orders/list.
  const orderReadableVenues = (venueId?: string): string[] => {
    if (venueId) {
      guard.venueFilter(venueId) // validates scope first (throws with the precise scope message)
      guard.requirePermission('orders:read', venueId)
      return [venueId]
    }
    return scope.allowedVenueIds.filter(v => {
      const access = scope.perVenueAccess.get(v)
      return !!access && hasPermission(access, 'orders:read')
    })
  }

  server.tool(
    'recent_orders',
    'Recent orders across your venues (or one venue): order number, type, status, total, venue, time, plus whether the sale was refunded (refundState NONE/PARTIAL/FULL and refundedAmount in pesos). Most recent first. Pass venueId to focus one venue.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      limit: z.number().int().min(1).max(50).default(15).describe('Max orders to return'),
    },
    async ({ venueId, limit }) => {
      const where = { venueId: { in: orderReadableVenues(venueId) } } // scope + orders:read gate (see helper)
      const orders = await prisma.order.findMany({
        where,
        select: {
          id: true,
          orderNumber: true,
          type: true,
          status: true,
          total: true,
          createdAt: true,
          venue: { select: { name: true } },
          // Sólo para el carril del reembolso (ver abajo): tres columnas de los
          // pagos COMPLETED, no el pago entero. El array no sale en la respuesta.
          payments: { where: { status: TransactionStatus.COMPLETED }, select: { amount: true, tipAmount: true, type: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      // 🔴 Una venta devuelta queda CERRADA y MARCADA (founder, 2026-08-18): el
      // saldo ya no se reabre, así que sin este campo el operador —y el LLM que
      // lee esto— no puede distinguirla de una cobrada. Mismo resumen que usan
      // los cuatro canales de cobro. Dinero en PESOS, como todo el MCP.
      return text({
        count: orders.length,
        orders: orders.map(({ payments, ...rest }) => {
          const refunds = summarizeRefunds(payments)
          return { ...rest, refundState: refunds.refundState, refundedAmount: Number(refunds.refundedAmount) }
        }),
      })
    },
  )

  server.tool(
    'find_order',
    'Find one order by its human ORDER NUMBER (what the operator sees on receipts/screens, e.g. ORD-5454 or FAST-1781718731451), by its internal id, or by a serial number (SIM/ICCID/barcode) of an item sold on it. Returns the order header, line items, payments, and whether the sale was refunded (refundState NONE/PARTIAL/FULL + refundedAmount in pesos) — but only if the order belongs to one of your venues. NOTE: a refunded sale stays status COMPLETED / paymentStatus PAID and its total is NOT rewritten (the Mexican CFDI de Egreso requires preserving the original sale) — read refundState, never the payment status, to answer "¿se devolvió esta venta?". Pass exactly one of orderNumber, orderId, or serialNumber. Prefer orderNumber. If multiple matches are returned, ask which venue/order; never pick the newest automatically. Pass venueId to narrow the lookup.',
    {
      venueId: z.string().optional().describe('Sucursal concreta; pídela si hay varias coincidencias'),
      orderNumber: z
        .string()
        .optional()
        .describe('The human order number shown on receipts/screens (e.g. ORD-5454, FAST-1781718731451) — case-insensitive'),
      orderId: z.string().optional().describe('The internal order id (cuid) — operators rarely have this; prefer orderNumber'),
      serialNumber: z.string().optional().describe('A serial number / barcode / ICCID of an item sold on the order'),
    },
    async ({ venueId, orderNumber, orderId, serialNumber }) => {
      if ([orderNumber, orderId, serialNumber].filter(value => value?.trim()).length !== 1) {
        return text({
          found: false,
          needsInput: true,
          field: 'orderNumber',
          reason: 'Pass orderNumber, orderId, or serialNumber',
          question: '¿Cuál es el número de orden, su identificador o el serial? Indica sólo uno.',
        })
      }
      const where = { venueId: { in: orderReadableVenues(venueId) } }
      let id = orderId?.trim()
      if (!id) {
        const serial = serialNumber?.trim()
        const matches = await prisma.order.findMany({
          where: {
            ...where,
            ...(serial
              ? {
                  items: {
                    some: { serializedItem: { serialNumber: { in: [...new Set([serial, serial.toUpperCase(), serial.toLowerCase()])] } } },
                  },
                }
              : { orderNumber: { equals: orderNumber!.trim(), mode: 'insensitive' as const } }),
          },
          select: { id: true, venueId: true, orderNumber: true, createdAt: true, venue: { select: { name: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 11,
        })
        if (!matches.length)
          return text({
            found: false,
            reason: orderNumber
              ? `No order found with number "${orderNumber}" in your venues`
              : `No order found for serial "${serialNumber}" in your venues`,
          })
        if (matches.length > 1)
          return text({
            found: false,
            needsInput: true,
            field: venueId ? 'orderId' : 'venueId',
            question: venueId ? '¿Cuál de estas órdenes buscas?' : '¿De qué sucursal es la orden?',
            candidates: matches.slice(0, 10),
            hasMore: matches.length > 10,
            instruction: 'Pide elegir una coincidencia o acotar la sucursal. No elijas la más reciente automáticamente.',
          })
        id = matches[0].id
      }
      const order = await prisma.order.findFirst({
        where: { id, ...where }, // scope: null if the order is not one of your venues'
        select: {
          id: true,
          venueId: true,
          orderNumber: true,
          type: true,
          status: true,
          paymentStatus: true,
          total: true,
          discountAmount: true,
          createdAt: true,
          venue: { select: { name: true } },
          items: {
            select: {
              id: true,
              productName: true,
              quantity: true,
              unitPrice: true,
              total: true,
              discountAmount: true,
              appliedDiscountId: true,
              course: true, // TABLE_SERVICE course/tiempo (null = inmediato)
              // Ata la línea al combo que la creó (null = línea suelta). Sin esto,
              // un combo se leía como "tres productos con descuento" sin nombre.
              orderPromotionId: true,
            },
          },
          // Promociones vendidas en la orden. Ningún POS del mercado deja el
          // nombre del combo fuera del detalle de la venta (Fudo lo imprime con
          // sus componentes debajo; Square marca "part of the Burger Combo").
          promotions: {
            select: {
              id: true,
              snapshotJson: true,
              grossCents: true,
              discountCents: true,
              netCents: true,
              needsReview: true,
              items: { select: { id: true } },
            },
          },
          // `type` distingue un reembolso (Payment NEGATIVO type REFUND) de un
          // cobro. Se devuelve tal cual: es dato útil para quien lee la orden.
          payments: { select: { amount: true, tipAmount: true, method: true, status: true, type: true, createdAt: true } },
        },
      })
      if (!order) return text({ found: false, reason: 'Order not found, or it is outside your venues' })
      // 🔑 El nombre sale del SNAPSHOT (lo que se cobró), no de la promoción viva:
      // renombrarla no puede reescribir una venta pasada. Dinero en PESOS (÷100):
      // OrderPromotion guarda centavos internamente, como el ledger contable.
      const promotions = (order.promotions ?? []).map(p => {
        // `snapshotJson` es Prisma.JsonValue (unión con string/number/array): el cast
        // directo a objeto no compila, hay que pasar por `unknown`.
        const snapshot = (p.snapshotJson ?? {}) as unknown as { name?: string; type?: string; pricingMode?: string }
        return {
          id: p.id,
          name: snapshot.name ?? 'Promoción',
          type: snapshot.type ?? null, // BUNDLE | COMBO
          pricingMode: snapshot.pricingMode ?? null, // FIXED_TOTAL | PER_UNIT (2x1)
          gross: p.grossCents / 100,
          discount: p.discountCents / 100,
          net: p.netCents / 100,
          needsReview: p.needsReview,
          itemIds: p.items.map(i => i.id),
        }
      })
      // 🔴 Una venta devuelta queda CERRADA y MARCADA (founder, 2026-08-18): el
      // saldo no se reabre, así que `paymentStatus` sigue diciendo PAID y sin
      // esto el reembolso sería invisible salvo leyendo los pagos uno por uno.
      // Sólo los COMPLETED devuelven dinero. Pesos, como todo el MCP.
      const refunds = summarizeRefunds((order.payments ?? []).filter(p => p.status === TransactionStatus.COMPLETED))
      return text({
        found: true,
        order: { ...order, promotions, refundState: refunds.refundState, refundedAmount: Number(refunds.refundedAmount) },
      })
    },
  )

  server.tool(
    'open_orders',
    'Open / unpaid tabs RIGHT NOW across your venues (or one venue): orders still owing money (paymentStatus PENDING or PARTIAL, not cancelled) — table, covers, type, status, total, already paid, remaining balance, item count, and when it was opened. Oldest first (the tabs to chase). Plus the total still owed across all of them. Answers "¿qué cuentas tengo abiertas? ¿qué mesas no han pagado? ¿cuánto me deben ahorita?". Pass venueId to focus one venue.',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      limit: z.number().int().min(1).max(50).default(25).describe('Max open orders to return (oldest first)'),
    },
    async ({ venueId, limit }) => {
      const where = {
        venueId: { in: orderReadableVenues(venueId) }, // scope + orders:read gate (see helper)
        paymentStatus: { in: [PaymentStatus.PENDING, PaymentStatus.PARTIAL] },
        status: { notIn: [OrderStatus.CANCELLED, OrderStatus.DELETED] },
      }
      const [summary, orders] = await Promise.all([
        prisma.order.aggregate({ where, _count: { _all: true }, _sum: { remainingBalance: true, total: true, paidAmount: true } }),
        prisma.order.findMany({
          where,
          select: {
            id: true,
            orderNumber: true,
            type: true,
            status: true,
            paymentStatus: true,
            total: true,
            paidAmount: true,
            remainingBalance: true,
            covers: true,
            createdAt: true,
            table: { select: { number: true } },
            venue: { select: { name: true } },
            _count: { select: { items: true } },
          },
          orderBy: { createdAt: 'asc' }, // oldest open first — the tabs to chase
          take: limit,
        }),
      ])
      return text({
        count: orders.length,
        outstanding: {
          openOrders: summary._count._all,
          totalOwed: num(summary._sum.remainingBalance), // what you're still owed across all open tabs
          grossTotal: num(summary._sum.total),
          alreadyPaid: num(summary._sum.paidAmount),
        },
        orders: orders.map(o => ({
          id: o.id,
          orderNumber: o.orderNumber,
          venue: o.venue?.name ?? null,
          table: o.table?.number ?? null,
          covers: o.covers,
          type: o.type,
          status: o.status,
          paymentStatus: o.paymentStatus, // PENDING | PARTIAL
          total: num(o.total),
          paid: num(o.paidAmount),
          balance: num(o.remainingBalance),
          items: o._count.items,
          openedAt: o.createdAt.toISOString(),
        })),
      })
    },
  )

  server.tool(
    'search_orders',
    'Search orders across your venues (or one venue) with filters: by status (pending/preparing/completed/cancelled/…), type (dine-in/takeout/delivery/pickup/manual), and/or a date range (default last 7 days). Returns a summary (count + total) and the matching orders (number, venue, table, type, status, payment status, total, time), newest first. The flexible version of recent_orders — answers "¿cuántas órdenes canceladas ayer? ¿pedidos a domicilio de hoy? ¿órdenes de la semana?". Pass venueId to focus one venue; optionally status, type, fromDate/toDate (YYYY-MM-DD).',
    {
      venueId: z.string().optional().describe('Focus one venue (must be in your scope); omit for all your venues'),
      status: z
        .enum(['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled', 'deleted', 'all'])
        .optional()
        .describe("Filter by order status (default 'all')"),
      type: z
        .enum(['dine_in', 'takeout', 'delivery', 'pickup', 'manual_entry', 'all'])
        .optional()
        .describe("Filter by order type (default 'all')"),
      fromDate: z.string().optional().describe('Start date YYYY-MM-DD (default: 7 days ago)'),
      toDate: z.string().optional().describe('End date YYYY-MM-DD (default: today)'),
      limit: z.number().int().min(1).max(100).default(25).describe('Max orders to list (newest first)'),
    },
    async ({ venueId, status, type, fromDate, toDate, limit }) => {
      const base = { venueId: { in: orderReadableVenues(venueId) } } // scope + orders:read gate (see helper)
      let tz = 'America/Mexico_City'
      if (venueId) {
        const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
        tz = venue?.timezone || tz
      }
      const start = venueStartOfDay(tz, fromDate ? new Date(`${fromDate}T12:00:00`) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
      const end = venueEndOfDay(tz, toDate ? new Date(`${toDate}T12:00:00`) : undefined)
      const where = {
        ...base,
        createdAt: { gte: start, lte: end },
        ...(status && status !== 'all' ? { status: ORDER_STATUS_MAP[status] } : {}),
        ...(type && type !== 'all' ? { type: ORDER_TYPE_MAP[type] } : {}),
      }

      const [summary, orders] = await Promise.all([
        prisma.order.aggregate({ where, _count: { _all: true }, _sum: { total: true } }),
        prisma.order.findMany({
          where,
          select: {
            orderNumber: true,
            type: true,
            status: true,
            paymentStatus: true,
            total: true,
            createdAt: true,
            venue: { select: { name: true } },
            table: { select: { number: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
      ])

      return text({
        window: { start: start.toISOString(), end: end.toISOString() },
        timezone: tz,
        summary: { count: summary._count._all, total: num(summary._sum.total) },
        shown: orders.length,
        orders: orders.map(o => ({
          orderNumber: o.orderNumber,
          venue: o.venue?.name ?? null,
          table: o.table?.number ?? null,
          type: o.type,
          status: o.status,
          paymentStatus: o.paymentStatus,
          total: num(o.total),
          at: o.createdAt.toISOString(),
        })),
      })
    },
  )

  server.tool(
    'pos_sync_status',
    'Offline-first: últimos intents reproducidos al reconectar. Incluye abrir/cobrar, mutaciones de cuenta, separar/fusionar, KDS_TICKET_MARK (marca general legacy) y KDS_ITEM_PROGRESS (liberar, preparar, listo, entregar o corregir cantidades por producto). Muestra dispositivo y ACKED / REJECTED con errorCode / PROCESSING. Los conflictos de preparación requieren revisión visible; RETRY es transitorio y no se persiste. Answers "¿qué se sincronizó al volver el internet? ¿qué operación requiere revisión?". Pass venueId.',
    {
      venueId: z.string().describe('Venue cuyos replays offline leer (must be in your scope)'),
      limit: z.number().int().min(1).max(200).optional().describe('Máximo de intents (default 50)'),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      const intents = await getRecentIntents(venueId, limit ?? 50)
      const rejected = intents.filter(i => i.status === 'REJECTED').length
      return text({
        venueId,
        total: intents.length,
        rejected,
        intents: intents.map(i => ({
          type: i.type,
          status: i.status,
          errorCode: i.errorCode ?? null,
          deviceId: i.deviceId,
          seq: i.seq ?? null,
          at: i.createdAt.toISOString(),
        })),
      })
    },
  )
}
