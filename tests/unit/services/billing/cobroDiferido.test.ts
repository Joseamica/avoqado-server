/**
 * D3 (5-nov-2026): quedarse con el plan de una prueba REGALADA difiere el primer cobro al fin de la prueba («como
 * Shopify»). Una sola regla para el checkout (Stripe exige ≥ 48 h para `trial_end`) y para lo que Facturación ofrece
 * (≥ 72 h, margen para la pestaña abierta): Facturación nunca ofrece lo que el checkout ya no daría.
 */
import { MARGEN_CHECKOUT_MS, MARGEN_OFERTA_MS, finDePruebaDiferible } from '@/services/billing/cobroDiferido'

const H = 3600000
const AHORA = Date.UTC(2026, 10, 27, 15)
const fila = (over: Record<string, unknown> = {}) => ({
  active: true,
  suspendedAt: null as Date | null,
  stripeSubscriptionId: null as string | null,
  endDate: new Date(AHORA + 8 * 24 * H) as Date | null,
  feature: { code: 'PLAN_PRO' },
  ...over,
})

describe('finDePruebaDiferible', () => {
  it('prueba regalada vigente del MISMO plan → su fecha de fin, tal cual', () => {
    const f = fila()
    expect(finDePruebaDiferible(f, 'PLAN_PRO', AHORA, MARGEN_CHECKOUT_MS)).toBe(f.endDate)
  })

  it('los márgenes: el checkout acepta desde 48 h y la oferta desde 72 h', () => {
    expect(MARGEN_CHECKOUT_MS).toBe(48 * H)
    expect(MARGEN_OFERTA_MS).toBe(72 * H)
    const justo48 = fila({ endDate: new Date(AHORA + 48 * H) })
    expect(finDePruebaDiferible(justo48, 'PLAN_PRO', AHORA, MARGEN_CHECKOUT_MS)).toEqual(justo48.endDate)
    expect(finDePruebaDiferible(justo48, 'PLAN_PRO', AHORA, MARGEN_OFERTA_MS)).toBeNull()
    expect(finDePruebaDiferible(fila({ endDate: new Date(AHORA + 48 * H - 1) }), 'PLAN_PRO', AHORA, MARGEN_CHECKOUT_MS)).toBeNull()
  })

  it.each([
    ['otro plan', fila(), 'PLAN_PREMIUM'],
    ['ya ligada a Stripe', fila({ stripeSubscriptionId: 'sub_1' }), 'PLAN_PRO'],
    ['inactiva', fila({ active: false }), 'PLAN_PRO'],
    ['suspendida', fila({ suspendedAt: new Date(AHORA) }), 'PLAN_PRO'],
    ['cortesía permanente (sin fecha)', fila({ endDate: null }), 'PLAN_PRO'],
    ['ya vencida', fila({ endDate: new Date(AHORA - H) }), 'PLAN_PRO'],
  ])('%s → null (sin diferir)', (_caso, f, tier) => {
    expect(finDePruebaDiferible(f, tier, AHORA, MARGEN_CHECKOUT_MS)).toBeNull()
  })

  it('sin fila → null', () => {
    expect(finDePruebaDiferible(null, 'PLAN_PRO', AHORA, MARGEN_CHECKOUT_MS)).toBeNull()
  })
})
