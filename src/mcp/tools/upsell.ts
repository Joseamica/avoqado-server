import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { getPerformance } from '@/services/upsell/upsellImpression.service'
import {
  getUpsellSurfaces,
  resolveForDto,
  PRODUCT_VALIDATION_SELECT,
  evaluateLinkedDiscountForPos,
  type LinkedDiscountRejectReason,
} from '@/services/upsell/upsell.service'
import {
  validateAndResolveModifiers,
  UpsellModifierError,
  type ProductForValidation,
  type SuggestedModifierSelection,
} from '@/services/upsell/upsellModifiers'
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
    'Sugerencias al cobrar ("¿algo más?") de un venue: cuánto dinero atribuido generaron, el aumento real de ticket medido contra el grupo de control, dónde están prendidas (mostrador / mesa ordenando / mesa cobrando), las reglas activas y las propuestas que esperan decisión del dueño. Si el producto sugerido pide una opción obligatoria (tamaño, sabor…), `suggestedModifiers` la trae ya resuelta con nombre y precio — vacío si no pide nada, o si la selección quedó inválida por un cambio de catálogo. Cada regla trae por qué NO llegaría al POS: `vetadoPorElDueno` (lo vetó en la ficha del producto), `desactivadoEnCatalogo` (el producto está apagado), `seVendePorPeso` (se vende por peso — el POS nunca lo puede sugerir de un toque), `pideOpcionesSinResolver` (pide una opción obligatoria que esta regla no resolvió) y, si tiene promoción ligada, `descuentoLigado.porQueNoLlega`. NO sabe si hay existencias — eso lo calcula el POS en el dispositivo, así que "sin existencias" nunca va a aparecer aquí aunque sea la causa real. Responde "¿cómo van mis sugerencias al cobrar?", "¿sirve el upsell?", "¿tengo propuestas pendientes?", "¿por qué no sale la sugerencia del agua?". Requiere plan PRO. Pasa venueId.',
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
            // `active` NO está en `PRODUCT_VALIDATION_SELECT` (no lo necesita para
            // validar modificadores) — se agrega encima para poder reportar
            // `desactivadoEnCatalogo`, igual que ya hace `listRules` en el servicio.
            suggestedProduct: { select: { ...PRODUCT_VALIDATION_SELECT, name: true, active: true } },
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
                // 🔴 Sin esto, `evaluateLinkedDiscountForPos` no compila: declara
                // `maxTotalUses` como requerido. Antes de reusar esa función este
                // `select` se había desincronizado en silencio del de
                // `listActiveRulesForPos` — con la función compartida, TypeScript
                // exige traer los mismos campos que el POS.
                maxTotalUses: true,
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
        // Apagado en el catálogo (`Product.active=false`): `listActiveRulesForPos`
        // también lo filtra al servir al POS, así que una regla así NUNCA se
        // dispara aunque siga `ACTIVE` y sin veto — mismo motivo `DESACTIVADO` que
        // ya reporta el dashboard (`avoqado-web-dashboard/src/lib/upsell/suggestability.ts`).
        desactivadoEnCatalogo: r.suggestedProduct ? r.suggestedProduct.active === false : null,
        // 🔴 Ronda final de correcciones (2026-08-17): faltaba este motivo. El
        // dato YA venía en el select (`PRODUCT_VALIDATION_SELECT` trae
        // `soldByWeight`) pero nunca se reportaba — una regla para un producto
        // por peso se leía perfectamente sana aquí y el POS la descartaba
        // siempre (`UpsellResolver.kt` / `validateAndResolveModifiers`), sin
        // que el MCP pudiera explicar por qué.
        seVendePorPeso: r.suggestedProduct ? r.suggestedProduct.soldByWeight === true : null,
        // Opciones obligatorias YA resueltas (nombre y precio) — mismo shape que
        // recibe el POS (`PosUpsellRuleDTO.suggestedModifiers`). [] = el producto
        // no pide nada; también [] si la selección quedó inválida por un cambio
        // de catálogo o por el veto/soldByWeight del producto (fail-open, igual
        // que del lado del POS).
        suggestedModifiers: resolveForDto(r.suggestedProduct, r.suggestedModifiers, r.id, venueId),
        // La regla pide una opción obligatoria (tamaño, sabor…) y su selección NO
        // la resuelve. `suggestedModifiers` de arriba ya colapsó a [] por el
        // fail-open de `resolveForDto` — sin este campo "no pide nada" y "pide y
        // quedó sin resolver" se leen exactamente igual.
        pideOpcionesSinResolver: r.suggestedProduct ? faltanOpcionesPorResolver(r.suggestedProduct, r.suggestedModifiers) : null,
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
 * ¿Esta regla no llega al POS porque pide una opción obligatoria (tamaño,
 * sabor…) y su selección no la resuelve?
 *
 * `resolveForDto` (arriba) usa el MISMO validador pero atrapa cualquier error y
 * colapsa a `[]` a propósito — fail-open: una regla con catálogo cambiado no
 * puede tumbar el resto de las sugerencias (ver su docstring en
 * `services/upsell/upsell.service.ts`). Eso es correcto para lo que resuelve
 * (`suggestedModifiers`), pero deja a este campo ciego: "no pide nada" y "pide y
 * quedó sin resolver" se ven idénticos. Por eso aquí SÍ se llama al validador
 * puro directo (`validateAndResolveModifiers`, sin pasar por `resolveForDto`) y
 * se lee su `.code` — sin tocar el fail-open del POS.
 *
 * `PRODUCT_NOT_SUGGESTABLE` (veto del dueño / se vende por peso) NO cuenta para
 * este campo: el veto ya tiene el suyo (`vetadoPorElDueno`) y gana primero —
 * `validateAndResolveModifiers` lo lanza ANTES de mirar los modificadores, así
 * que un producto vetado nunca reporta `pideOpcionesSinResolver: true` aunque
 * también le falte una opción.
 */
function faltanOpcionesPorResolver(product: ProductForValidation, selection: unknown): boolean {
  try {
    validateAndResolveModifiers(product, selection as SuggestedModifierSelection[] | null)
    return false
  } catch (error) {
    return (
      error instanceof UpsellModifierError &&
      (error.code === 'MISSING_REQUIRED_MODIFIER' || error.code === 'MODIFIER_NOT_IN_GROUP' || error.code === 'MODIFIER_INACTIVE')
    )
  }
}

/**
 * El descuento ligado a una regla, y —si el POS no lo va a recibir— POR QUÉ.
 *
 * 🔴 Existe por un defecto real (2026-08-17): el descuento nunca llegaba al POS y
 * la tarjeta mostraba precio de lista, así que la promoción del local no se
 * aplicaba y no había NADA que mirar para darse cuenta. El POS sólo sirve
 * descuentos que puede cobrar exacto y que el endpoint de órdenes no va a
 * rechazar (ver `evaluateLinkedDiscountForPos` en
 * `services/upsell/upsell.service.ts`); este campo dice si pasó ese filtro y, si
 * no, cuál fue el motivo.
 *
 * 🔴 Ronda 2 (2026-08-17): esta función reimplementaba esa cadena de condiciones
 * A MANO y se desincronizó de verdad — un commit posterior (`8501d866`) le
 * agregó a `linkedDiscountParaPos` el chequeo de `maxTotalUses` y a esta copia
 * no, así que el MCP decía `llegaAlPos: true` para un descuento que el POS ya
 * excluía. Ahora llama a `evaluateLinkedDiscountForPos` — la MISMA función que
 * usa `listActiveRulesForPos` para servir al POS — en vez de mantener su propia
 * copia. Sólo la TRADUCCIÓN a frase (`explicarMotivoDescuento`) vive aquí.
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
    maxTotalUses: number | null
    buyQuantity: number | null
    validFrom: Date | null
    validUntil: Date | null
  } | null
}) {
  const d = r.linkedDiscount
  if (!d) return null

  const motivo = evaluateLinkedDiscountForPos(d, r.suggestedProductId, new Date())

  return {
    nombre: d.name,
    tipo: d.type,
    // PESOS o porcentaje, unidades mayores — la plataforma no usa centavos.
    valor: Number(d.value),
    llegaAlPos: motivo === null,
    porQueNoLlega: motivo === null ? null : explicarMotivoDescuento(motivo, d),
  }
}

/** Traduce el código de `evaluateLinkedDiscountForPos` a la frase que lee el dueño. */
function explicarMotivoDescuento(motivo: LinkedDiscountRejectReason, d: { type: string; scope: string }): string {
  switch (motivo) {
    case 'DISABLED':
      return 'El descuento está desactivado'
    case 'UNSUPPORTED_TYPE':
      return `El POS no sabe cobrar descuentos de tipo ${d.type}`
    case 'BUY_X_GET_Y_FREE':
      return 'Es un 2x1: el POS no lo pinta como tarjeta'
    case 'HAS_MIN_PURCHASE':
      return 'Tiene compra mínima, y una sugerencia suelta casi nunca la alcanza'
    case 'HAS_MAX_DISCOUNT_CAP':
      return 'Tiene tope de descuento, y el POS no puede reproducir el tope al centavo'
    case 'USAGE_CAP_SET':
      return 'Tiene tope de usos: entre que se sirve la tarjeta y se cobra se puede agotar'
    case 'SCOPE_NOT_ITEM':
      return `Su alcance es ${d.scope}, y sólo los de artículo se pueden aplicar a una línea`
    case 'PRODUCT_NOT_TARGETED':
      return 'No cubre al producto que sugiere esta regla'
    case 'NOT_YET_STARTED':
      return 'Todavía no empieza'
    case 'EXPIRED':
      return 'Ya venció'
  }
}
