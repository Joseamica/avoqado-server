import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { planesPublicos, type PlanPagadoPublico, type PrecioPublico } from '@/services/billing/planesPublicos'
import AppError from '@/errors/AppError'

// CAPABILITY NOTE (MCP sync, planes editables B4 Task 1): la lectura pública de los planes pagados vigentes
// (GET /api/v1/public/plan-offer) también vive aquí, de sólo lectura. Es la única tool de los planes: no cotiza, no cobra ni
// cambia nada (el checkout y el editor de la oferta siguen sin ser tools, ver `subscriptions.ts`). Los servicios guardan centavos
// (excepción declarada de Stripe); esta tool convierte ÷100 en su frontera y contesta SÓLO pesos.

const pesos = (cents: number) => Math.round(cents) / 100
const precio = (p: PrecioPublico) => ({ priceWithoutTax: pesos(p.netCents), priceWithTax: pesos(p.grossCents) })
const plan = (tier: 'PRO' | 'PREMIUM', p: PlanPagadoPublico) => ({
  tier,
  name: p.displayName,
  onSale: p.onSale,
  requiresCard: p.requiresCard,
  trialDays: p.trialDays,
  monthly: precio(p.monthly),
  annual: precio(p.annual),
})

export function registerPlanPricesTools(server: McpServer, _scope: McpScope) {
  server.tool(
    'plan_prices',
    'Current Avoqado plans and prices: for the Free, Pro and Premium plans, the name, whether it is on sale, free-trial days, whether the trial asks for a card, and the monthly and annual price in pesos (MXN) without VAT and with VAT included. Read-only and the same for every account; use it to answer "how much does Pro cost" or "what does the trial need".',
    {},
    async () => {
      try {
        const o = await planesPublicos()
        return text({
          currency: 'MXN',
          offerVersion: o.offerVersion,
          plans: [{ tier: 'FREE', name: o.FREE.displayName }, plan('PRO', o.PRO), plan('PREMIUM', o.PREMIUM)],
        })
      } catch (error) {
        if (error instanceof AppError && error.code === 'PLAN_NOT_CONFIGURED') return text({ ok: false, error: error.message })
        throw error
      }
    },
  )
}
