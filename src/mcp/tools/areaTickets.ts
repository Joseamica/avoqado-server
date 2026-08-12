import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { createGuard } from '../guard'
import { text } from '../respond'
import type { McpScope } from '../scope'

const decimal = (value: { toString(): string } | null): string | null => (value == null ? null : value.toString())

export function registerAreaTicketTools(server: McpServer, scope: McpScope): void {
  const guard = createGuard(scope)

  server.tool(
    'area_ticket_status',
    'Look up an area ticket or final delivery receipt by its scanned code. Returns payment, claim, print and delivery state without changing anything. For a ticket on the EXTERNAL settlement route (another POS charges it in its own register — Avoqado never sees that money), also returns settlementRoute and the externalSettlement sub-object (status/handoffState/confirmationMode/amounts). Venue-scoped and read-only.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
      code: z.string().trim().min(1).max(64).describe('Area-ticket code or final delivery-receipt code'),
    },
    async ({ venueId, code }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('orders:read', venueId)

      const [ticket, order] = await Promise.all([
        prisma.areaTicket.findUnique({
          where: { venueId_code: { venueId, code } },
          select: {
            id: true,
            code: true,
            status: true,
            total: true,
            printStatus: true,
            issuedAt: true,
            claimedAt: true,
            claimExpiresAt: true,
            paidAt: true,
            cancelledAt: true,
            expiresAt: true,
            // AVOQADO (caja propia) o EXTERNAL (otro POS cobra en SU caja — Avoqado
            // nunca ve ese dinero). Sin esto, un vale EXTERNAL se veía indistinguible
            // de uno normal desde este tool (Task 13, plan "caja externa fase 1").
            settlementRoute: true,
            fulfillmentArea: { select: { id: true, name: true } },
            checkoutSession: { select: { id: true, status: true } },
            order: {
              select: {
                id: true,
                orderNumber: true,
                paymentStatus: true,
                areaDeliveryCode: true,
              },
            },
            fulfillment: {
              select: {
                deliveredAt: true,
                method: true,
                deliveredByStaff: { select: { firstName: true, lastName: true } },
              },
            },
            // `issueAreaTicket` SOLO crea esta fila cuando el área es EXTERNAL — en
            // un vale AVOQADO viene `null`, y eso es el caso normal, no un dato que
            // falte. Nunca se convierte en un Payment ni se llama "pagado": queda
            // "confirmado" o "asumido" (ver el comentario en
            // areaTicketExternal.mobile.service.ts).
            externalSettlement: {
              select: {
                status: true,
                handoffState: true,
                confirmationMode: true,
                referenceAmount: true,
                externalAmount: true,
                externalReference: true,
                confirmedAt: true,
                notes: true,
                confirmedByStaff: { select: { firstName: true, lastName: true } },
              },
            },
          },
        }),
        prisma.order.findUnique({
          where: { venueId_areaDeliveryCode: { venueId, areaDeliveryCode: code } },
          select: {
            id: true,
            orderNumber: true,
            paymentStatus: true,
            areaDeliveryCode: true,
            areaTickets: {
              select: {
                id: true,
                code: true,
                status: true,
                total: true,
                fulfillmentArea: { select: { id: true, name: true } },
                fulfillment: { select: { deliveredAt: true, method: true } },
              },
              orderBy: { issuedAt: 'asc' },
            },
          },
        }),
      ])

      if (!ticket && !order) return text({ found: false, code })
      if (ticket) {
        return text({
          found: true,
          kind: 'AREA_TICKET',
          ticket: {
            ...ticket,
            total: decimal(ticket.total),
            deliveredBy: ticket.fulfillment?.deliveredByStaff
              ? `${ticket.fulfillment.deliveredByStaff.firstName} ${ticket.fulfillment.deliveredByStaff.lastName}`.trim()
              : null,
            externalSettlement: ticket.externalSettlement
              ? {
                  status: ticket.externalSettlement.status,
                  handoffState: ticket.externalSettlement.handoffState,
                  confirmationMode: ticket.externalSettlement.confirmationMode,
                  // Pesos 1:1, igual que `total` arriba — NUNCA centavos.
                  referenceAmount: decimal(ticket.externalSettlement.referenceAmount),
                  externalAmount: decimal(ticket.externalSettlement.externalAmount),
                  externalReference: ticket.externalSettlement.externalReference,
                  confirmedAt: ticket.externalSettlement.confirmedAt,
                  confirmedBy: ticket.externalSettlement.confirmedByStaff
                    ? `${ticket.externalSettlement.confirmedByStaff.firstName} ${ticket.externalSettlement.confirmedByStaff.lastName}`.trim()
                    : null,
                  notes: ticket.externalSettlement.notes,
                }
              : null,
          },
        })
      }
      return text({
        found: true,
        kind: 'DELIVERY_RECEIPT',
        order: {
          ...order,
          areaTickets: order!.areaTickets.map(candidate => ({
            ...candidate,
            total: decimal(candidate.total),
          })),
        },
      })
    },
  )

  server.tool(
    'pending_area_ticket_deliveries',
    'List area tickets still waiting for physical delivery to the customer, oldest ISSUED first, grouped by emitting area. Covers BOTH settlement routes: AVOQADO tickets already PAID, and EXTERNAL tickets whose charge in the other register was already confirmed or assumed (settlementRoute + externalSettlement tell the two apart — a PENDING/NOT_CHARGED external ticket is never eligible here). Read-only; requires area-tickets:deliver.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('area-tickets:deliver', venueId)
      const tickets = await prisma.areaTicket.findMany({
        where: {
          venueId,
          fulfillment: null,
          // Espejo verificado CAMPO POR CAMPO contra la autoridad de este
          // dominio, `listPendingAreaTicketFulfillment` en
          // `areaTicketV7.mobile.service.ts:1963-1995` (fix round 1 de la Task
          // 13 — la ronda anterior solo había verificado la mitad EXTERNAL y
          // este comentario afirmaba paridad completa sin haberla revisado;
          // ver el reporte). Dos diferencias quedan a propósito, nombradas
          // para que nadie las lea como un hueco sin explicar:
          //   - La autoridad además filtra por `fulfillmentAreaId` de UNA
          //     terminal (el dispositivo de entrega autenticado). Este tool
          //     es de venue completo — "grouped by emitting area" en su
          //     descripción de arriba — así que no hay una sola área que
          //     filtrar: es la diferencia entre "qué ve ESTA terminal" y "qué
          //     hay pendiente en TODO el venue", no un campo olvidado.
          //   - La autoridad pagina con cursor (`decodePendingCursor`); este
          //     tool siempre usó `limit` simple, desde antes de la Task 13.
          //     No se agrega paginación por cursor aquí — sería un cambio de
          //     contrato que nadie pidió.
          fulfillmentModeSnapshot: { not: 'IMMEDIATE' },
          // Unión explícita por ruta — nativos: pagados como siempre, Y con su
          // orden todavía viva. Externos: cobro ya elegible en la otra caja. Un
          // vale EXTERNAL NUNCA llega a status PAID (el CHECK de la Task 2 se lo
          // impide), así que sin la segunda rama la ruta EXTERNAL era invisible
          // en esta cola — el hueco que cierra la Task 13.
          OR: [
            {
              settlementRoute: 'AVOQADO',
              status: 'PAID',
              // Sin este filtro, un vale que se quedó marcado PAID pero cuya
              // orden se canceló o se borró DESPUÉS seguía apareciendo aquí
              // como "pendiente de entregar", mientras que la cola real del
              // personal (la autoridad de arriba) ya lo ignoraba — el hueco
              // concreto que encontró la revisión de esta ronda.
              order: { paymentStatus: 'PAID', status: { notIn: ['CANCELLED', 'DELETED'] } },
            },
            {
              settlementRoute: 'EXTERNAL',
              status: 'ISSUED',
              fulfillmentArea: { externalDeliveryTracking: 'TRACKED' },
              // "Ya cobrado afuera" = alguien lo confirmó (con o sin diferencia de
              // importe) o el área lo asume al imprimir — el MISMO conjunto de
              // estados (YA_COBRADO_AFUERA) que habilita entregar en
              // `fulfillAreaTicket`. PENDING y NOT_CHARGED quedan fuera a
              // propósito: todavía no hay autorización para soltar el producto.
              externalSettlement: { status: { in: ['CONFIRMED', 'DISCREPANCY', 'ASSUMED'] } },
            },
          ],
        },
        select: {
          id: true,
          code: true,
          issuedAt: true,
          paidAt: true,
          total: true,
          settlementRoute: true,
          fulfillmentArea: { select: { id: true, name: true } },
          order: { select: { id: true, orderNumber: true, areaDeliveryCode: true } },
          externalSettlement: { select: { status: true, referenceAmount: true, externalAmount: true } },
          _count: { select: { lines: true } },
        },
        // `issuedAt`, no `paidAt`: un vale EXTERNAL nunca tiene `paidAt` (esa
        // columna solo la escribe la transición AVOQADO→PAID), así que ordenar
        // por ella dejaría a los externos sin un orden real (NULLs al final,
        // sin importar cuánto llevaran esperando). `issuedAt` sí existe siempre
        // y es el mismo criterio que usa la cola equivalente del lado móvil.
        orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
        take: limit,
      })
      return text({
        count: tickets.length,
        tickets: tickets.map(ticket => ({
          ...ticket,
          total: decimal(ticket.total),
          lines: ticket._count.lines,
          _count: undefined,
          // Solo existe en la ruta EXTERNAL — null en cualquier vale AVOQADO.
          externalSettlement: ticket.externalSettlement
            ? {
                status: ticket.externalSettlement.status,
                referenceAmount: decimal(ticket.externalSettlement.referenceAmount),
                externalAmount: decimal(ticket.externalSettlement.externalAmount),
              }
            : null,
        })),
      })
    },
  )

  server.tool(
    'area_ticket_reconciliation_queue',
    'List TWO different reconciliation queues in one call: AVOQADO checkout sessions frozen because a payment outcome requires reconciliation (`sessions`), and open incidents on EXTERNAL-route tickets — unconfirmed charges, amount variances, etc. (`externalIncidents`) — opened by staff or by the hourly reconciliation job. Neither releases claims, retries payments, nor resolves an incident. Read-only; requires area-tickets:configure.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('area-tickets:configure', venueId)
      const [sessions, externalIncidents] = await Promise.all([
        prisma.areaTicketCheckoutSession.findMany({
          where: { venueId, status: 'RECONCILIATION_REQUIRED' },
          select: {
            id: true,
            status: true,
            activePaymentAttemptId: true,
            lastHeartbeatAt: true,
            updatedAt: true,
            terminal: { select: { id: true, name: true } },
            order: {
              select: {
                id: true,
                orderNumber: true,
                paymentStatus: true,
                total: true,
                paidAmount: true,
                remainingBalance: true,
              },
            },
            paymentAttempts: {
              select: {
                id: true,
                sequence: true,
                status: true,
                amount: true,
                method: true,
                paymentId: true,
                providerReference: true,
                lastCheckedAt: true,
              },
              orderBy: { sequence: 'asc' },
            },
            _count: { select: { tickets: true } },
          },
          orderBy: { updatedAt: 'asc' },
          take: limit,
        }),
        // Cola de la ruta EXTERNAL: cargos sin confirmar, discrepancias de importe,
        // etc. Es un dominio APARTE de `sessions` — un vale EXTERNAL nunca crea
        // AreaTicketCheckoutSession, así que nunca aparecería ahí. `status: 'OPEN'`
        // porque esto es trabajo pendiente, no historial — mismo criterio que ya
        // aplica `sessions` arriba con RECONCILIATION_REQUIRED. Las abre esta misma
        // acción (Task 7, discrepancia de importe) o el job horario de conciliación
        // (Task 12, cargo sin confirmar).
        prisma.areaTicketExternalIncident.findMany({
          where: { venueId, status: 'OPEN' },
          select: {
            id: true,
            kind: true,
            status: true,
            detail: true,
            openedAt: true,
            occurrenceCount: true,
            reopenedAt: true,
            areaTicket: { select: { id: true, code: true, fulfillmentArea: { select: { id: true, name: true } } } },
          },
          orderBy: { openedAt: 'asc' },
          take: limit,
        }),
      ])
      return text({
        count: sessions.length,
        sessions: sessions.map(session => ({
          ...session,
          ticketCount: session._count.tickets,
          _count: undefined,
          order: session.order
            ? {
                ...session.order,
                total: decimal(session.order.total),
                paidAmount: decimal(session.order.paidAmount),
                remainingBalance: decimal(session.order.remainingBalance),
              }
            : null,
          paymentAttempts: session.paymentAttempts.map(attempt => ({
            ...attempt,
            amount: decimal(attempt.amount),
          })),
        })),
        warning: 'No inicies otro cobro ni liberes claims desde esta consulta. Primero verifica el proveedor y el Payment asociado.',
        externalIncidents: {
          count: externalIncidents.length,
          items: externalIncidents.map(incident => ({
            id: incident.id,
            kind: incident.kind,
            status: incident.status,
            // Ya viene en pesos: quien abrió la incidencia (Task 7 o el job de la
            // Task 12) formateó los importes con `.toFixed(2)` antes de guardarla
            // — se reenvía tal cual, sin volver a tocarlo.
            detail: incident.detail,
            openedAt: incident.openedAt,
            occurrenceCount: incident.occurrenceCount,
            reopenedAt: incident.reopenedAt,
            ticket: incident.areaTicket
              ? {
                  id: incident.areaTicket.id,
                  code: incident.areaTicket.code,
                  area: incident.areaTicket.fulfillmentArea?.name ?? null,
                }
              : null,
          })),
          warning:
            'Una incidencia abierta NO bloquea el piso ni afirma nada por sí sola. UNCONFIRMED_CHARGE no significa "no se cobró" — hay que confirmarlo o declarar explícitamente que no se cobró (nunca inferirlo desde aquí).',
        },
      })
    },
  )

  server.tool(
    'pending_external_confirmations',
    'List EXTERNAL-route area tickets stuck waiting for a human to confirm the charge that happened in the OTHER register — Avoqado never saw that money move and has no independent proof of it. This is exactly the queue behind the dashboard\'s "cobros por confirmar" screen. Excludes tickets already CONFIRMED or in DISCREPANCY (someone already stated an outcome), NOT_CHARGED (already declared uncharged), ASSUMED (the venue opted out of confirming those — see ExternalConfirmationMode.ASSUME_ON_PRINT), and any ticket that is not ISSUED or not on the EXTERNAL route. Read-only — this tool never confirms anything. Requires area-tickets:configure.',
    {
      venueId: z.string().describe('Venue to inspect (must be in your scope)'),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ venueId, limit }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('area-tickets:configure', venueId)

      const tickets = await prisma.areaTicket.findMany({
        where: {
          venueId,
          // Espejo campo por campo de la autoridad de este criterio,
          // `listPendingExternalConfirmation` (Task 9,
          // areaTicketExternal.mobile.service.ts:608-616) — tres condiciones,
          // cada una descarta algo distinto:
          settlementRoute: 'EXTERNAL', // la ruta AVOQADO nunca tiene cobro externo que confirmar
          status: 'ISSUED', // CANCELLED/EXPIRED son vales muertos, nada que confirmar
          externalSettlement: { status: 'PENDING' },
          // ↑ deja fuera CONFIRMED y NOT_CHARGED (alguien ya declaró qué pasó) y —
          // el que se presta a confusión — ASSUMED: nace de la política
          // ExternalConfirmationMode.ASSUME_ON_PRINT, que por diseño NO exige
          // verificación humana. Meterlo aquí le daría al operador una tarea que
          // el propio local decidió que no hacía falta (ver el comentario 🔴 en
          // la autoridad, líneas 572-582 del mismo archivo).
          //
          // Divergencia deliberada frente a la autoridad — nombrada, no un hueco:
          // `listPendingExternalConfirmation` ADEMÁS filtra por el
          // `fulfillmentAreaId` de la terminal autenticada que hace la llamada.
          // Este tool no tiene esa sesión de dispositivo de la que derivar un
          // área — un operador de MCP pregunta por el VENUE completo, no por "el
          // área de mi terminal" — así que lista todas las áreas y expone `area`
          // por fila para distinguirlas. Mismo patrón, misma razón, que ya
          // declaró `pending_area_ticket_deliveries` arriba.
        },
        select: {
          id: true,
          code: true,
          issuedAt: true,
          fulfillmentArea: { select: { id: true, name: true } },
          externalSettlement: { select: { referenceAmount: true, handoffState: true, confirmationMode: true } },
        },
        // Mismo orden que la autoridad: el más viejo primero, igual que se
        // acumula la urgencia real de confirmar.
        orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
        // La autoridad pagina con cursor (`decodePendingCursor`) porque la
        // consume un dispositivo con outbox propio. Este tool usa `limit`
        // simple, igual que `pending_area_ticket_deliveries` arriba y por la
        // misma razón: agregar paginación por cursor aquí sería un cambio de
        // contrato que nadie pidió.
        take: limit,
      })

      return text({
        count: tickets.length,
        items: tickets.map(ticket => {
          const settlement = ticket.externalSettlement! // el WHERE de arriba ya garantiza que existe y está PENDING
          return {
            id: ticket.id,
            code: ticket.code,
            issuedAt: ticket.issuedAt,
            area: ticket.fulfillmentArea?.name ?? null,
            // Pesos 1:1, igual que sus vecinos — NUNCA centavos.
            referenceAmount: decimal(settlement.referenceAmount),
            handoffState: settlement.handoffState,
            confirmationMode: settlement.confirmationMode,
          }
        }),
        warning:
          'Solo lectura. Confirmar un cobro externo, o declarar que no se cobró, se hace en el dashboard o el POS del área — ningún tool de este MCP lo hace. No infieras que un vale de esta lista ya tiene cobro confirmado o asumido: si aparece aquí es justamente porque nadie lo ha resuelto todavía.',
      })
    },
  )
}
