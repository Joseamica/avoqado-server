import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { getPerformance } from '@/services/upsell/upsellImpression.service'
import { getUpsellSurfaces } from '@/services/upsell/upsell.service'
import { parseDbDateRange } from '@/utils/datetime'
import { UpsellRuleStatus } from '@prisma/client'

/**
 * Upsell "¿Algo más?" — lectura desde el MCP.
 *
 * Spec: Avoqado-HQ/specs/upsell-pantalla-cliente-2026-08-03.md
 *
 * SÓLO LECTURA a propósito. Aprobar una propuesta prende una tarjeta que ven los
 * CLIENTES del negocio; que un asistente lo haga interpretando "sí, aprueba las que
 * se vean bien" es exactamente la clase de escritura que la regla del MCP manda
 * poner detrás de confirmación. Se lee aquí, se aprueba en el dashboard.
 */
export function registerUpsellTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'upsell_status',
    'Sugerencias al cobrar ("¿algo más?") de un venue: cuánto dinero atribuido generaron, el aumento real de ticket medido contra el grupo de control, dónde están prendidas (mostrador / mesa ordenando / mesa cobrando), las reglas activas y las propuestas que esperan decisión del dueño. Responde "¿cómo van mis sugerencias al cobrar?", "¿sirve el upsell?", "¿tengo propuestas pendientes?". Requiere plan PRO. Pasa venueId.',
    {
      venueId: z.string().describe('Venue a consultar (debe estar en tu alcance)'),
      from: z.string().optional().describe('Inicio del rango, YYYY-MM-DD (hora local del venue). Default: hace 30 días'),
      to: z.string().optional().describe('Fin del rango, YYYY-MM-DD (hora local del venue). Default: hoy'),
    },
    async ({ venueId, from, to }) => {
      guard.venueFilter(venueId) // lanza ScopeError si el venue no es tuyo
      guard.requirePermission('upsells:read', venueId)

      // 🔴 `UPSELL` es un Feature (tier), NO un Module: va por `planGateMessage`,
      // que resuelve contra el sistema de Features. Gatearlo con el resolver de
      // Modules falla EN SILENCIO — casi todos los venues de prod están
      // grandfathered y pasarían igual, o sea que el candado no candaría nada.
      const gate = await planGateMessage(venueId, 'UPSELL', 'Las sugerencias al cobrar') // tier PRO
      if (gate) return text({ ok: false, error: gate })

      const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
      // Fechas VENUE-LOCAL. Nunca `new Date('YYYY-MM-DD')` pelado: prod corre en UTC
      // y el rango se desfasaría un día entero.
      const range = parseDbDateRange(from, to, venue?.timezone ?? undefined, 30)

      const [performance, surfaces, rules] = await Promise.all([
        getPerformance(venueId, range.from, range.to),
        getUpsellSurfaces(venueId),
        prisma.upsellRule.findMany({
          where: { venueId, status: { in: [UpsellRuleStatus.ACTIVE, UpsellRuleStatus.PROPOSED] } },
          select: {
            status: true,
            origin: true,
            headline: true,
            rationale: true,
            supportCount: true,
            lift: true,
            suggestedProduct: { select: { name: true, upsellEnabled: true } },
          },
          orderBy: [{ status: 'asc' }, { priority: 'desc' }],
          take: 50,
        }),
      ])

      const mapRule = (r: (typeof rules)[number]) => ({
        product: r.suggestedProduct?.name ?? null,
        origin: r.origin, // OWNER | BASKET_DATA | AI | PROMOTION
        headline: r.headline,
        // El dueño vetó el producto: la regla existe pero NO se sirve al POS.
        vetadoPorElDueno: r.suggestedProduct ? !r.suggestedProduct.upsellEnabled : null,
        // `lift` es un ratio de ordenamiento, no dinero: 2.5 = se compran juntos
        // 2.5× más seguido que el promedio.
        lift: r.lift === null ? null : Number(r.lift),
        ticketsDeEvidencia: r.supportCount,
        porQue: r.rationale,
      })

      return text({
        venueId,
        rango: { from: range.from, to: range.to },
        desempeno: {
          // Dinero en PESOS, unidades mayores. La plataforma no usa centavos.
          ventasAtribuidas: performance.attributedSales,
          // `null` cuando no hay muestra suficiente. Es deliberado: un número
          // inventado se lee como real.
          aumentoRealDeTicket: performance.measuredLift,
          momentosConTarjetas: performance.shownCount,
          momentosAceptados: performance.acceptedCount,
          tasaDeAceptacion: performance.acceptanceRate,
          // El grupo de control: no vieron nada, a propósito. Es el único modo de
          // saber si el aumento es real o si habrían comprado igual.
          momentosDeControl: performance.holdoutCount,
          ticketPromedioConTarjetas: performance.avgTicketShown,
          ticketPromedioSinTarjetas: performance.avgTicketHoldout,
          hayDatos: performance.hasData,
        },
        dondeEstaPrendido: surfaces,
        activas: rules.filter(r => r.status === UpsellRuleStatus.ACTIVE).map(mapRule),
        esperandoDecision: rules.filter(r => r.status === UpsellRuleStatus.PROPOSED).map(mapRule),
        nota: 'Aprobar o descartar propuestas se hace desde el dashboard: prende tarjetas que ven los clientes.',
      })
    },
  )
}
