/**
 * Planes editables B4, Task 4: el bot de soporte nombra los planes por la versión vigente, y el editor rechaza un nombre que el bot
 * no podría decir. Lo de las guías sin precios va en su propio cambio (toca la biblioteca firmada): `guiasSinPrecios.test.ts`.
 */
// El bot lee los nombres por el servicio del panel (B4); aquí ese servicio pasa por el de los avisos, también fingido
jest.mock('@/services/dashboard/planState.service', () => ({
  getPlanState: jest.fn(),
  nombresDeLosPlanesDeTuPlan: () => jest.requireMock('@/services/billing/nombresDeLosPlanes').nombresDeLosPlanes(),
}))
jest.mock('@/services/billing/nombresDeLosPlanes', () => ({ nombresDeLosPlanes: jest.fn() }))

import { nombresDeLosPlanes } from '@/services/billing/nombresDeLosPlanes'
import { entradaDesdeDefinicion, ofertaDeRespaldo, problemasDeLaOferta, type PlanOfferInput } from '@/services/billing/planOffer'
import { getPlanState, type PlanState } from '@/services/dashboard/planState.service'
import { planStatus } from '@/services/support/data/capabilities/planStatus'
import type { DataScope } from '@/services/support/data/catalog'
import { checkRendered } from '@/services/support/data/check'
import { nombreQueElBotPuedeDecir } from '@/services/support/data/planText'

describe('el bot nombra los planes por la versión vigente', () => {
  const scope: DataScope = {
    venueId: 'ckq7z1x2y0000abcd1234efgh',
    organizationId: 'org',
    venueName: 'Mi negocio',
    timezone: 'America/Mexico_City',
    day: '2026-11-12',
    kycVerified: true,
    now: new Date('2026-11-12T20:32:00Z'),
    rows: 5,
    openOrdersDays: 7,
    depositGroups: 2000,
    depositTimeoutMs: 3000,
  } as any
  const estado = {
    hasPlan: true,
    state: 'active',
    grandfathered: false,
    origin: { kind: 'CLASSIC', tier: 'PRO', currentPeriodEnd: null, cancelAt: null, paymentIssue: null },
  } as unknown as PlanState

  it('con la v2 «Plus» el texto de «Tu plan» dice «Plus»', async () => {
    jest.mocked(getPlanState).mockResolvedValue(estado)
    jest.mocked(nombresDeLosPlanes).mockResolvedValue({ FREE: 'Inicial', PRO: 'Plus', PREMIUM: 'Max' })
    const dato = await planStatus.read(scope, {} as never)
    const out = planStatus.render(scope, {} as never, dato)
    expect((out as { text: string }).text).toBe('Plan de Mi negocio (corte 14:32): Plus.')
    expect(checkRendered(out as never, scope.timezone)).toBe(true)
  })

  it('sin versión del editor sigue diciendo «Pro»', async () => {
    jest.mocked(getPlanState).mockResolvedValue(estado)
    jest.mocked(nombresDeLosPlanes).mockResolvedValue({ FREE: 'Gratis', PRO: 'Pro', PREMIUM: 'Premium' })
    const dato = await planStatus.read(scope, {} as never)
    expect((planStatus.render(scope, {} as never, dato) as { text: string }).text).toBe('Plan de Mi negocio (corte 14:32): Pro.')
  })
})

describe('el editor sólo acepta nombres que el bot puede decir', () => {
  const SLOT: Record<string, 'FREE' | 'PRO' | 'PREMIUM'> = { Gratis: 'FREE', Premium: 'PREMIUM' }
  const entrada = (nombre: string): PlanOfferInput => {
    const base = entradaDesdeDefinicion(ofertaDeRespaldo())
    const plan = SLOT[nombre] ?? 'PRO'
    return { ...base, [plan]: { ...base[plan], displayName: nombre } }
  }
  const problemaDelNombre = (nombre: string) => problemasDeLaOferta(entrada(nombre)).filter(p => p.path.endsWith('.displayName'))

  // «Pro $799» ya lo frenaba el juego de caracteres del editor (el `$`); los demás, la regla del bot
  it('rechaza «Pro $799»', () => {
    expect(nombreQueElBotPuedeDecir('Pro $799')).toBe(false)
    expect(problemaDelNombre('Pro $799').length).toBe(1)
  })

  it.each(['Plan IVA', 'Plus MXN', 'Plus 20261127', 'Pro www.x.com'])('rechaza «%s»', nombre => {
    expect(nombreQueElBotPuedeDecir(nombre)).toBe(false)
    expect(problemaDelNombre(nombre)).toEqual([
      {
        path: 'PRO.displayName',
        message: 'Este nombre no lo puede decir el asistente de WhatsApp: quita precios, monedas, «IVA», números largos, ligas o correos.',
      },
    ])
  })

  it.each(['Plus', 'Gratis', 'Pro', 'Premium'])('acepta «%s»', nombre => {
    expect(nombreQueElBotPuedeDecir(nombre)).toBe(true)
    expect(problemaDelNombre(nombre)).toEqual([])
  })

  it('la v1 sembrada (Gratis, Pro, Premium) no tiene problemas', () => {
    expect(problemasDeLaOferta(entradaDesdeDefinicion(ofertaDeRespaldo()))).toEqual([])
  })

  it.each(['Plus <b>', 'Pro & Co', 'Pro "X"', 'Pro >'])('un nombre con HTML («%s») es un problema en PRO.displayName', nombre => {
    expect(problemaDelNombre(nombre).length).toBeGreaterThan(0)
  })
})
