/**
 * «Como lo hace Claude» (founder, 21-sep-2026), paso 2: qué le pasaría HOY a este negocio si
 * se mudara a `tier` — con nombre, precio y la suscripción de Stripe que habría que cancelar.
 *
 * Sólo LEE. No cancela ni cobra: es lo que alimenta la cotización que el cliente ve antes de
 * decidir, y después la cancelación. Que las dos salgan de la misma fuente es lo que impide
 * que la pantalla prometa una cosa y el cobro haga otra.
 */
const mockFindMany = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venueFeature: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
}))
jest.mock('../../../src/services/stripe.service', () => ({ cancelSubscription: jest.fn(), createTrialSubscriptions: jest.fn() }))
jest.mock('../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { sueltasQueAbsorbeElPlan } from '../../../src/services/dashboard/venueFeature.dashboard.service'

const fila = (code: string, monthlyPrice: number, sub: string | null = `sub_${code}`) => ({
  id: `vf_${code}`,
  monthlyPrice,
  stripeSubscriptionId: sub,
  feature: { code, name: code },
})

beforeEach(() => jest.clearAllMocks())

describe('sueltasQueAbsorbeElPlan', () => {
  it('al mudarse a PREMIUM, el inventario contratado aparte queda absorbido', async () => {
    mockFindMany.mockResolvedValue([fila('INVENTORY_TRACKING', 89)])

    const r = await sueltasQueAbsorbeElPlan('venue-1', 'PREMIUM')

    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ code: 'INVENTORY_TRACKING', monthlyPrice: 89, stripeSubscriptionId: 'sub_INVENTORY_TRACKING' })
  })

  it('🔴 al mudarse a PRO el inventario NO se absorbe: Pro no lo incluye y el cliente lo pagó', async () => {
    mockFindMany.mockResolvedValue([fila('INVENTORY_TRACKING', 89)])
    await expect(sueltasQueAbsorbeElPlan('venue-1', 'PRO')).resolves.toEqual([])
  })

  it('separa lo absorbido de lo que se conserva', async () => {
    mockFindMany.mockResolvedValue([fila('INVENTORY_TRACKING', 89), fila('LOYALTY_PROGRAM', 599)])

    const r = await sueltasQueAbsorbeElPlan('venue-1', 'PRO')

    expect(r.map(x => x.code)).toEqual(['LOYALTY_PROGRAM'])
  })

  it('nunca propone cancelar el PLAN mismo', async () => {
    mockFindMany.mockResolvedValue([fila('PLAN_PRO', 999), fila('LOYALTY_PROGRAM', 599)])

    const r = await sueltasQueAbsorbeElPlan('venue-1', 'PREMIUM')

    expect(r.map(x => x.code)).toEqual(['LOYALTY_PROGRAM'])
  })

  it('🔴 una suelta SUSPENDIDA o vencida pero ligada a Stripe ES candidata: puede seguir cobrando', async () => {
    // Codex, 21-sep (las dos pasadas): «suspendida en local» NO es «ya no cobra». Stripe sigue en
    // `past_due` con reintentos, o ya renovó y el webhook no llegó. Descartarla dejaba el solape
    // sin cancelar al subir de plan: te cobraban las dos.
    mockFindMany.mockResolvedValue([])
    await sueltasQueAbsorbeElPlan('venue-1', 'PREMIUM')

    const where = mockFindMany.mock.calls[0][0].where
    expect(where.venueId).toBe('venue-1')
    // No se filtra por la ventana local en el nivel de arriba…
    expect(where).not.toHaveProperty('suspendedAt')
    expect(where).not.toHaveProperty('active')
    // …y basta con estar ligada a Stripe para entrar.
    expect(where.OR).toEqual(expect.arrayContaining([{ stripeSubscriptionId: { not: null } }]))
  })

  it('la consulta está acotada (tope y orden estable)', async () => {
    mockFindMany.mockResolvedValue([])
    await sueltasQueAbsorbeElPlan('venue-1', 'PREMIUM')
    const q = mockFindMany.mock.calls[0][0]
    expect(q.take).toBeGreaterThan(0)
    expect(q.orderBy).toBeDefined()
  })

  it('una absorbida SIN suscripción de Stripe se reporta igual, para no ocultarla', async () => {
    mockFindMany.mockResolvedValue([fila('LOYALTY_PROGRAM', 599, null)])

    const r = await sueltasQueAbsorbeElPlan('venue-1', 'PREMIUM')

    expect(r[0]).toMatchObject({ code: 'LOYALTY_PROGRAM', stripeSubscriptionId: null })
  })
})
