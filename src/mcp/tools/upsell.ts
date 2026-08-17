import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { getPerformance } from '@/services/upsell/upsellImpression.service'
import { getUpsellSurfaces, resolveForDto, PRODUCT_VALIDATION_SELECT } from '@/services/upsell/upsell.service'
import { parseDbDateRange } from '@/utils/datetime'
import { Prisma, UpsellRuleStatus } from '@prisma/client'

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
    'Sugerencias al cobrar ("¿algo más?") de un venue: cuánto dinero atribuido generaron, el aumento real de ticket medido contra el grupo de control, dónde están prendidas (mostrador / mesa ordenando / mesa cobrando), las reglas activas y las propuestas que esperan decisión del dueño. Si el producto sugerido pide una opción obligatoria (tamaño, sabor…), `suggestedModifiers` la trae ya resuelta con nombre y precio — vacío si no pide nada, o si la selección quedó inválida por un cambio de catálogo. Responde "¿cómo van mis sugerencias al cobrar?", "¿sirve el upsell?", "¿tengo propuestas pendientes?". Requiere plan PRO. Pasa venueId.',
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
            id: true,
            status: true,
            origin: true,
            headline: true,
            rationale: true,
            supportCount: true,
            lift: true,
            suggestedProductId: true,
            // Selección cruda (ids); se resuelve más abajo con `resolveForDto`,
            // igual que el POS — mismo nombre y precio, nunca ids pelados.
            suggestedModifiers: true,
            suggestedProduct: { select: { ...PRODUCT_VALIDATION_SELECT, name: true } },
            // Para poder contestar "¿por qué mi promoción no sale en la tarjeta?".
            // Sin esto, una regla de origen PROMOTION se ve idéntica tenga o no un
            // descuento servible, y el operador no tiene dónde mirar.
            linkedDiscount: {
              select: {
                name: true,
                type: true,
                value: true,
                active: true,
                scope: true,
                targetItemIds: true,
                minPurchaseAmount: true,
                maxDiscountAmount: true,
                buyQuantity: true,
                validFrom: true,
                validUntil: true,
              },
            },
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
        // Opciones obligatorias YA resueltas (nombre y precio) — mismo shape que
        // recibe el POS (`PosUpsellRuleDTO.suggestedModifiers`). [] = el producto
        // no pide nada; también [] si la selección quedó inválida por un cambio
        // de catálogo o por el veto/soldByWeight del producto (fail-open, igual
        // que del lado del POS).
        suggestedModifiers: resolveForDto(r.suggestedProduct, r.suggestedModifiers, r.id, venueId),
        // `lift` es un ratio de ordenamiento, no dinero: 2.5 = se compran juntos
        // 2.5× más seguido que el promedio.
        lift: r.lift === null ? null : Number(r.lift),
        ticketsDeEvidencia: r.supportCount,
        porQue: r.rationale,
        descuentoLigado: descuentoLigado(r),
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

/**
 * El descuento ligado a una regla, y —si el POS no lo va a recibir— POR QUÉ.
 *
 * 🔴 Existe por un defecto real (2026-08-17): el descuento nunca llegaba al POS y
 * la tarjeta mostraba precio de lista, así que la promoción del local no se
 * aplicaba y no había NADA que mirar para darse cuenta. El POS sólo sirve
 * descuentos que puede cobrar exacto y que el endpoint de órdenes no va a
 * rechazar (ver `linkedDiscountParaPos` en `services/upsell/upsell.service.ts`);
 * este campo dice si pasó ese filtro y, si no, cuál fue el motivo.
 */
function descuentoLigado(r: {
  suggestedProductId: string
  linkedDiscount: {
    name: string
    type: string
    value: Prisma.Decimal
    active: boolean
    scope: string
    targetItemIds: string[]
    minPurchaseAmount: Prisma.Decimal | null
    maxDiscountAmount: Prisma.Decimal | null
    buyQuantity: number | null
    validFrom: Date | null
    validUntil: Date | null
  } | null
}) {
  const d = r.linkedDiscount
  if (!d) return null

  const ahora = new Date()
  const motivo = !d.active
    ? 'El descuento está desactivado'
    : d.type !== 'PERCENTAGE' && d.type !== 'FIXED_AMOUNT'
      ? `El POS no sabe cobrar descuentos de tipo ${d.type}`
      : d.buyQuantity !== null
        ? 'Es un 2x1: el POS no lo pinta como tarjeta'
        : d.minPurchaseAmount !== null
          ? 'Tiene compra mínima, y una sugerencia suelta casi nunca la alcanza'
          : d.maxDiscountAmount !== null
            ? 'Tiene tope de descuento, y el POS no puede reproducir el tope al centavo'
            : d.scope !== 'ITEM'
              ? `Su alcance es ${d.scope}, y sólo los de artículo se pueden aplicar a una línea`
              : d.targetItemIds.length > 0 && !d.targetItemIds.includes(r.suggestedProductId)
                ? 'No cubre al producto que sugiere esta regla'
                : d.validFrom && d.validFrom > ahora
                  ? 'Todavía no empieza'
                  : d.validUntil && d.validUntil < ahora
                    ? 'Ya venció'
                    : null

  return {
    nombre: d.name,
    tipo: d.type,
    // PESOS o porcentaje, unidades mayores — la plataforma no usa centavos.
    valor: Number(d.value),
    llegaAlPos: motivo === null,
    porQueNoLlega: motivo,
  }
}
