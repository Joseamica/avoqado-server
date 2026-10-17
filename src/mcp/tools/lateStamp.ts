import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { formatInTimeZone } from 'date-fns-tz'
import { PaymentType, TransactionStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { DEFAULT_TIMEZONE } from '@/utils/datetime'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { attachCustomerToOrder } from '@/services/mobile/order.mobile.service'
import { previewSaleStamp, type SaleStampPreview } from '@/services/shared/loyaltyOnLateCustomer'

/** Cuántas ventas candidatas se le muestran al operador cuando el número de orden se repite (se pide una más para saber si hay más). */
const CANDIDATAS_A_MOSTRAR = 5

const NO_ENCONTRE_LA_VENTA = 'No encontré esa venta en este negocio.'
const NO_EXISTE_EL_CLIENTE = 'Ese cliente no existe en este negocio. Búscalo primero con find_customer.'

/**
 * El servicio del POS (`attachCustomerToOrder`) lanza estos dos en inglés. Aquí sólo llegan por una carrera (la venta o el cliente
 * desaparecieron entre la vista previa y el `confirm`): el operador los lee con los mismos textos de la validación de arriba.
 */
const EN_ESPANOL = new Map<string, string>([
  ['Order not found', NO_ENCONTRE_LA_VENTA],
  ['Customer not found', NO_EXISTE_EL_CLIENTE],
])

/**
 * «¿suma sello?» en palabras del operador. Misma regla que el POS (`loyaltyOnLateCustomer.ts`).
 * Sin tarjeta de sellos activa la respuesta es «no» pase lo que pase con la venta: decir «todavía no» o «pasaron 24 h» sugeriría
 * que en otro caso sí sumaría.
 */
function sumaSello(v: SaleStampPreview | null): { respuesta: 'sí' | 'no' | 'todavía no'; porque: string } {
  if (!v) return { respuesta: 'no', porque: 'no pude leer la venta' }
  if (!v.stampsEnabled) return { respuesta: 'no', porque: 'el negocio no tiene activa la tarjeta de sellos' }
  switch (v.decision) {
    case 'OPEN':
      return { respuesta: 'todavía no', porque: 'la venta sigue abierta: el sello se decide cuando se cobre completa' }
    case 'NOT_PAID':
      return { respuesta: 'no', porque: 'la venta no está pagada completa, o se reembolsó o canceló' }
    case 'STAMPED':
      return { respuesta: 'no', porque: 'esta venta ya le sumó su sello a este cliente' }
    case 'OTHER_CUSTOMER':
      return { respuesta: 'no', porque: 'esta venta ya tiene otro cliente principal o su sello es de otro' }
    case 'NO_ANCHOR':
      return { respuesta: 'no', porque: 'no se sabe a qué hora se cobró la venta' }
    case 'WINDOW_EXPIRED':
      return { respuesta: 'no', porque: 'pasaron más de 24 h desde el cobro' }
    case 'NOT_APPLICABLE':
      return { respuesta: 'no', porque: 'es una venta de tarjetas de regalo: comprarlas no suma sellos (usarlas para pagar sí)' }
    case 'ELIGIBLE':
      if (v.dailyLimitReached) return { respuesta: 'no', porque: 'ya recibió su sello de hoy' }
      return { respuesta: 'sí', porque: 'está pagada, dentro de las 24 h y sin otro cliente' }
  }
}

/**
 * Sello tardío por el MCP (spec 2026-10-14 §3.1): «agrégale Dany a la venta ORD-…». Sólo en el catálogo LIBRE (`/mcp`); no está en
 * `src/mcp/directory/catalog.ts`. Liga por el MISMO servicio que «Agregar cliente» del POS (`attachCustomerToOrder`), que reabre la
 * lealtad durable en su transacción y da el sello con el staff conectado como actor.
 */
export function registerLateStampTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'attach_customer_to_sale',
    'Link a customer to a sale that was ALREADY charged (the cashier forgot to add them at checkout). The receipt and invoice then carry that customer and, if the venue runs a stamp card, the sale adds its stamp when it qualifies: fully paid, paid less than 24 hours ago, no other main customer on it, and the customer has not reached the stamps-per-day limit. Identify the sale with exactly ONE of orderNumber (as printed on the receipt) or paymentId, and the customer with customerId (look it up first with find_customer). By DEFAULT it only PREVIEWS ("Venta X · cliente Y · ¿suma sello? sí/no y por qué"); call again with confirm:true to link. If the order number matches more than one sale it lists them, each with its paymentId and venue-local time, and asks which — it never picks one; call again with that paymentId. Requires payments:create.',
    {
      venueId: z.string().describe('Venue where the sale was charged (must be in your scope)'),
      orderNumber: z.string().optional().describe('Order number as printed on the receipt, e.g. ORD-1790121567183'),
      paymentId: z.string().optional().describe('The payment id, when you have it instead of the order number'),
      customerId: z.string().describe('The customer to link (from find_customer)'),
      confirm: z.boolean().optional().describe('Must be true to actually link; without it you get a preview'),
    },
    async ({ venueId, orderNumber, paymentId, customerId, confirm }) => {
      guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
      guard.requirePermission('payments:create', venueId) // el mismo permiso que «Agregar cliente» del POS

      const numero = orderNumber?.trim()
      const pago = paymentId?.trim()
      if (Boolean(numero) === Boolean(pago)) {
        return text({
          ok: false,
          needsInput: true,
          field: 'orderNumber',
          question: '¿Cuál es el número de orden del ticket (o el id del pago)? Indica sólo uno.',
        })
      }

      let venta: { id: string; orderNumber: string } | null = null
      if (pago) {
        const p = await prisma.payment.findFirst({
          where: { id: pago, venueId },
          select: { order: { select: { id: true, orderNumber: true } } },
        })
        venta = p?.order ?? null
      } else {
        const ventas = await prisma.order.findMany({
          where: { venueId, orderNumber: { equals: numero!, mode: 'insensitive' } },
          select: {
            id: true,
            orderNumber: true,
            total: true,
            createdAt: true,
            paymentStatus: true,
            // El id del último COBRO completado: es lo que el operador le pasa de vuelta a esta tool (`paymentId`) para elegir una de
            // las ventas con el mismo número. 🔴 `type` es opcional: `not REFUND` solo dejaría fuera los NULL (mismo filtro que el
            // ancla del sello tardío en `loyaltyOnLateCustomer.ts`).
            payments: {
              where: { status: TransactionStatus.COMPLETED, OR: [{ type: null }, { type: { not: PaymentType.REFUND } }] },
              select: { id: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 1,
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: CANDIDATAS_A_MOSTRAR + 1,
        })
        if (ventas.length > 1) {
          const hayMasCoincidencias = ventas.length > CANDIDATAS_A_MOSTRAR
          const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
          const timezone = venue?.timezone || DEFAULT_TIMEZONE
          return text({
            ok: false,
            ambiguous: true,
            error: `El número ${numero} coincide con varias ventas de este negocio: dime cuál y pásame el paymentId de la que sea.${
              hayMasCoincidencias ? ` Te muestro las ${CANDIDATAS_A_MOSTRAR} más recientes; hay más.` : ''
            }`,
            timezone,
            matches: ventas.slice(0, CANDIDATAS_A_MOSTRAR).map(v => ({
              orderNumber: v.orderNumber,
              // null = la cuenta no tiene ningún cobro completado (sigue abierta): no hay pago con qué elegirla.
              paymentId: v.payments[0]?.id ?? null,
              total: Number(v.total),
              createdAt: v.createdAt.toISOString(),
              createdAtLocal: formatInTimeZone(v.createdAt, timezone, 'yyyy-MM-dd HH:mm'),
              paymentStatus: v.paymentStatus,
            })),
            hayMasCoincidencias,
          })
        }
        venta = ventas[0] ?? null
      }
      if (!venta) return text({ ok: false, error: NO_ENCONTRE_LA_VENTA })

      const cliente = await prisma.customer.findFirst({
        where: { id: customerId, venueId },
        select: { id: true, firstName: true, lastName: true, phone: true },
      })
      if (!cliente) return text({ ok: false, error: NO_EXISTE_EL_CLIENTE })
      const nombre = `${cliente.firstName ?? ''} ${cliente.lastName ?? ''}`.trim() || cliente.phone || '(sin nombre)'

      if (!confirm) {
        // 🔴 Vista previa obligatoria: liga un cliente a una venta cobrada y puede darle un sello (producto gratis).
        const vista = await previewSaleStamp({ venueId, orderId: venta.id, customerId: cliente.id })
        const { respuesta, porque } = sumaSello(vista)
        const entrada = { venueId, orderNumber, paymentId, customerId }
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            venta: venta.orderNumber,
            cliente: nombre,
            sumaSello: respuesta,
            motivo: porque,
            minutosDesdeElCobro: vista?.minutosDesdeElCobro ?? null,
          },
          message: `Venta ${venta.orderNumber} · cliente ${nombre} · ¿suma sello? ${respuesta} (${porque}). Confirma con el operador; luego vuelve a llamar con confirm:true.`,
          confirmationArgs: { ...Object.fromEntries(Object.entries(entrada).filter(([, v]) => v !== undefined)), confirm: true },
        })
      }

      try {
        const resultado = await attachCustomerToOrder(venueId, venta.id, cliente.id, scope.staffId)
        await auditMcpWrite(scope, {
          action: 'CUSTOMER_ATTACHED_TO_SALE',
          entity: 'Order',
          entityId: venta.id,
          venueId,
          data: {
            customerId: cliente.id,
            orderNumber: venta.orderNumber,
            stamped: resultado.loyalty?.stamped ?? false,
            reason: resultado.loyalty?.reason ?? null,
          },
        })
        return text({ ok: true, venta: venta.orderNumber, cliente: nombre, loyalty: resultado.loyalty })
      } catch (err) {
        const mensaje = (err as Error).message
        return text({ ok: false, error: EN_ESPANOL.get(mensaje) ?? mensaje })
      }
    },
  )
}
