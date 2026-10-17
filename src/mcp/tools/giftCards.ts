/**
 * Tarjetas de regalo — herramientas de LECTURA del MCP de clientes (spec §7; índice C5). Sólo en `/mcp` (modo libre); el
 * directorio certificado necesita su propia revisión. Sin candado de plan: un negocio que bajó de plan sigue debiendo el
 * saldo vendido y tiene que poder leerlo (spec §6). Dinero en PESOS; fechas = días del negocio. Nunca devuelven el código.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { getGiftCardLiabilityAging, getGiftCardSummary, listGiftCards } from '@/services/giftCards/giftCardReports.service'
import { getVenueTimezone } from '@/services/dashboard/commission/commission-utils'
import { formatInVenueTimezone } from '@/utils/datetime'

const DIA = /^\d{4}-\d{2}-\d{2}$/
const MAX_COINCIDENCIAS = 10

export function registerGiftCardTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'gift_cards_summary',
    'Gift cards (tarjetas de regalo) of a venue you can access, in PESOS: how many were SOLD (activated) in the period and for how much, how much balance customers USED (net of reversals), sales CANCELLED, manager adjustments, the LIVE BALANCE the business still owes today (and how much of it is already expired), and that balance by AGE since activation (0-30, 31-90, 91-180, 181-365, 366+ days) at the end of the period. Answers "¿cuánto vendí en tarjetas de regalo este mes?", "¿cuánto saldo deben mis tarjetas?", "¿qué tan viejo es ese saldo?". Dates are the venue\'s own calendar days (YYYY-MM-DD); by default, the current month up to today. Pass venueId. Requires giftCards:read. Works even if the business no longer has the plan: existing balances can always be read.',
    {
      venueId: z.string().describe('Venue whose gift cards to summarize (must be in your scope)'),
      fromDate: z
        .string()
        .regex(DIA, 'Usa AAAA-MM-DD')
        .optional()
        .describe('First day (YYYY-MM-DD, venue-local). Default: day 1 of the month of toDate (of the current month without toDate)'),
      toDate: z
        .string()
        .regex(DIA, 'Usa AAAA-MM-DD')
        .optional()
        .describe('Last day (YYYY-MM-DD, venue-local); the aging is measured at the end of this day. Default: today'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // lanza ScopeError fuera de alcance
      guard.requirePermission('giftCards:read', venueId) // espejo de las rutas del dashboard
      const timezone = await getVenueTimezone(venueId)
      const hoy = formatInVenueTimezone(new Date(), timezone, 'yyyy-MM-dd')
      const hasta = toDate ?? hoy
      // ⭐ (C5 menor 4): el inicio por defecto es el día 1 del mes de `hasta`; con sólo un toDate de un mes anterior, el día 1 del
      // mes actual quedaba después del fin (GIFT_CARD_RANGE_INVALID).
      const desde = fromDate ?? `${hasta.slice(0, 8)}01`
      const [resumen, antiguedad] = await Promise.all([
        getGiftCardSummary(venueId, { from: desde, to: hasta }),
        getGiftCardLiabilityAging(venueId, hasta),
      ])
      return text({ venueId, currency: 'MXN', ...resumen, aging: antiguedad })
    },
  )

  server.tool(
    'gift_card_lookup',
    'Find gift cards (tarjetas de regalo) of a venue you can access by the LAST 4 characters of their code, or by the customer, recipient or buyer (name, phone or email). For each card: last 4, status (PENDING = sold but not paid yet, ACTIVE, BLOCKED, DEACTIVATED), expired (true = its expiry already passed: it can NOT be used even if status is ACTIVE), initial amount and current balance in PESOS, activation and expiry days (venue-local), who it belongs to and its sale ticket. NEVER returns the full code. Up to 10 matches plus the total; if there are more, ask the user to be more specific. Pass venueId and last4 or customer. Requires giftCards:read.',
    {
      venueId: z.string().describe('Venue that issued the cards (must be in your scope)'),
      last4: z
        .string()
        .regex(/^[0-9A-Za-z]{4}$/, 'Son los últimos 4 caracteres del código')
        .optional()
        .describe('Last 4 characters of the card code'),
      customer: z.string().min(2).max(80).optional().describe('Customer, recipient or buyer: name, phone or email (partial)'),
    },
    async ({ venueId, last4, customer }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('giftCards:read', venueId)
      if (!last4 && !customer)
        return text({ found: false, error: 'Dime los últimos 4 caracteres del código, o el nombre, teléfono o correo del cliente.' })
      const timezone = await getVenueTimezone(venueId)
      const dia = (instante: string | null) => (instante ? formatInVenueTimezone(new Date(instante), timezone, 'yyyy-MM-dd') : null)
      const pagina = await listGiftCards(venueId, { last4, search: customer, pageSize: MAX_COINCIDENCIAS })
      const ahora = Date.now()
      if (pagina.total === 0) return text({ found: false, error: 'No encontré tarjetas de regalo con esos datos en este negocio.' })
      return text({
        found: true,
        venueId,
        currency: 'MXN',
        total: pagina.total,
        showing: pagina.items.length,
        moreThanShown: pagina.total > pagina.items.length,
        cards: pagina.items.map(t => ({
          last4: t.last4,
          status: t.status,
          initialAmount: t.initialAmount,
          balance: t.balance,
          activatedOn: dia(t.activatedAt),
          expiresOn: dia(t.expiresAt),
          // ⭐ (C5 menor 5, aditivo): la misma frontera que el saldo y la lista (vencida ⇔ expiresAt <= ahora), para que la IA nunca
          // le diga a un cliente que una tarjeta vencida sirve.
          expired: t.expiresAt !== null && Date.parse(t.expiresAt) <= ahora,
          customer: t.customer?.name ?? null,
          recipient: t.recipientName,
          buyer: t.purchaserName,
          saleTicket: t.order?.orderNumber ?? null,
        })),
      })
    },
  )
}
