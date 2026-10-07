/**
 * Pago al personal (SERVICE_PAY) — función del plan PRO (decisión D3 del founder, 5-oct-2026; spec fase 3 §10).
 *
 * 🔴 ESTE TEST EXISTE PARA QUE FALLE SI ALGUIEN LA MUEVE DE TIER o la deja fuera de la lista explícita del plan
 * (`LEGACY_PLAN_CODES`): fuera de esa lista `elPlanConcede` la niega a TODOS (Codex r1-8). Mismo patrón que
 * kitchenDisplayTierMirror.test.ts.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
    capabilityGrant: { findFirst: jest.fn() },
    hybridContract: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { FEATURE_CATALOG } from '../../../../src/config/featureCatalog'
import { elPlanConcede, FREE_TIER_CODES, PREMIUM_ONLY_CODES, venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'
import { compileHybridPublication } from '../../../../src/services/launchCampaigns/hybridOffer.service'

const db = prisma as any
const ACTIVO = { active: true, suspendedAt: null, endDate: null }

/** Una sede normal (no demo) con, a lo más, un plan clásico, una exención o un acceso de función suelta. */
function sede({ exenta = false, plan = null as null | 'PLAN_PRO' | 'PLAN_PREMIUM', suelta = false } = {}) {
  db.venue.findUnique.mockResolvedValue({ id: 'v1', seatCapExempt: exenta, organization: { seatCapExempt: false }, status: 'ACTIVE' })
  db.venueFeature.findFirst.mockResolvedValue(null)
  db.capabilityGrant.findFirst.mockResolvedValue(suelta ? { id: 'g1' } : null)
  db.venueFeature.findMany.mockImplementation(async ({ where }: any) =>
    plan && where?.feature?.code?.in?.includes(plan) ? [{ ...ACTIVO, feature: { code: plan } }] : [],
  )
}

beforeEach(() => jest.clearAllMocks())

describe('SERVICE_PAY es función del plan Pro (D3)', () => {
  it('Pro y Premium la conceden; no es diferenciador Premium ni promesa del plan gratis', () => {
    expect(elPlanConcede('PRO', 'SERVICE_PAY')).toBe(true)
    expect(elPlanConcede('PREMIUM', 'SERVICE_PAY')).toBe(true)
    expect(PREMIUM_ONLY_CODES).not.toContain('SERVICE_PAY')
    expect(FREE_TIER_CODES).not.toContain('SERVICE_PAY')
  })

  it.each([
    ['Pro de siempre', { plan: 'PLAN_PRO' as const }, true],
    ['Premium de siempre', { plan: 'PLAN_PREMIUM' as const }, true],
    ['Gratis (sin plan)', {}, false],
    ['sede exenta', { exenta: true }, true],
    ['suelta ($199 por sucursal: un acceso de función)', { suelta: true }, true],
  ])('%s → %s', async (_caso, config, esperado) => {
    sede(config)
    await expect(venueHasFeatureAccess('v1', 'SERVICE_PAY')).resolves.toBe(esperado)
  })

  it('está en el catálogo como función de Pro que se puede vender suelta con precio de lista', () => {
    expect(FEATURE_CATALOG.find(f => f.featureCode === 'SERVICE_PAY')).toMatchObject({
      id: 'SERVICE_PAY',
      category: 'team',
      minimumTier: 'PRO',
      offering: 'CONFIGURABLE',
      requirement: null,
    })
  })

  it.each(['PRO', 'PREMIUM'] as const)('una oferta de plan %s que se publique desde hoy la incluye', planTier => {
    const terms = {
      currency: 'MXN',
      interval: 'MONTHLY',
      price: 999,
      taxIncluded: true,
      promotionCycles: null,
      renewal: { kind: 'SAME_PRICE' },
    } as const
    expect(compileHybridPublication({ schemaVersion: 1, kind: 'PLAN', planTier, terms }).includedFeatureCodes).toContain('SERVICE_PAY')
  })
})
