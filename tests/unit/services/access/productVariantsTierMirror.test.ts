/**
 * Variantes de producto — espejo de tiers (founder, 12-oct: Pro y Premium).
 *
 * 🔴 ESTE TEST EXISTE PARA QUE FALLE SI ALGUIEN MUEVE PRODUCT_VARIANTS DE TIER. PRO ya no es blanket: concede sólo su lista
 * explícita (`LEGACY_PLAN_CODES`), así que PRODUCT_VARIANTS tiene que estar ahí, y no en `PREMIUM_ONLY_CODES` (le quitaría
 * la función a los Pro). Mismo patrón que kitchenDisplayTierMirror.
 */

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
    // Cobro híbrido: sin concesiones sueltas ni contrato de plan; el acceso sale sólo del plan clásico.
    capabilityGrant: { findFirst: jest.fn().mockResolvedValue(null) },
    hybridContract: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { FREE_TIER_CODES, PREMIUM_ONLY_CODES, elPlanConcede, venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'
import { FEATURE_CATALOG } from '../../../../src/config/featureCatalog'
import { planIncludes } from '../../../../src/services/launchCampaigns/hybridOffer.service'

const findFirst = (prisma as any).venueFeature.findFirst as jest.Mock
const findMany = (prisma as any).venueFeature.findMany as jest.Mock
const venueFindUnique = (prisma as any).venue.findUnique as jest.Mock
const ACTIVE = { active: true, suspendedAt: null, endDate: null }

function codeFilter(where: any): { single?: string; list?: string[] } {
  const code = where?.feature?.code
  if (typeof code === 'string') return { single: code }
  if (code && Array.isArray(code.in)) return { list: code.in }
  return {}
}

/** Venue normal (no grandfathered, no demo) con UN plan activo. */
function mockTierVenue(tierCode: string) {
  venueFindUnique.mockResolvedValue({ id: 'v1', seatCapExempt: false, status: 'ACTIVE' })
  findFirst.mockResolvedValue(null) // sin grant propio del código consultado
  findMany.mockImplementation(async ({ where }: any) => {
    const { list } = codeFilter(where)
    if (list && list.includes(tierCode)) return [{ ...ACTIVE, feature: { code: tierCode } }]
    return []
  })
}

beforeEach(() => jest.clearAllMocks())

describe('espejo de tiers — variantes de producto (founder 12-oct: Pro y Premium)', () => {
  it('🔴 no es Premium-only ni gratis', () => {
    expect(PREMIUM_ONLY_CODES).not.toContain('PRODUCT_VARIANTS')
    expect(FREE_TIER_CODES).not.toContain('PRODUCT_VARIANTS')
  })

  it('PRO y PREMIUM la conceden', () => {
    expect(elPlanConcede('PRO', 'PRODUCT_VARIANTS')).toBe(true)
    expect(elPlanConcede('PREMIUM', 'PRODUCT_VARIANTS')).toBe(true)
  })

  it('un negocio PRO la tiene (de punta a punta, igual que pantalla de cocina)', async () => {
    mockTierVenue('PLAN_PRO')
    await expect(venueHasFeatureAccess('v1', 'PRODUCT_VARIANTS')).resolves.toBe(true)
  })

  it('un negocio PREMIUM la tiene', async () => {
    mockTierVenue('PLAN_PREMIUM')
    await expect(venueHasFeatureAccess('v1', 'PRODUCT_VARIANTS')).resolves.toBe(true)
  })

  it('🔴 Review Focus 5: un negocio SIN plan (Gratis) no la tiene', async () => {
    // Mismo arreglo que «un negocio SIN plan no» de kitchenDisplayTierMirror.test.ts.
    venueFindUnique.mockResolvedValue({ id: 'v1', seatCapExempt: false, status: 'ACTIVE' })
    findFirst.mockResolvedValue(null)
    findMany.mockResolvedValue([])
    await expect(venueHasFeatureAccess('v1', 'PRODUCT_VARIANTS')).resolves.toBe(false)
  })

  it('el catálogo de funciones la anuncia como PRO', () => {
    expect(FEATURE_CATALOG.find(f => f.id === 'PRODUCT_VARIANTS')).toMatchObject({
      featureCode: 'PRODUCT_VARIANTS',
      minimumTier: 'PRO',
      offering: 'CONFIGURABLE',
      requirement: null,
    })
  })

  it('🔴 un plan PRO/PREMIUM publicado (contrato híbrido) la incluye; FREE no: planIncludes sólo mete FREE o CONFIGURABLE', () => {
    const entry = FEATURE_CATALOG.find(f => f.id === 'PRODUCT_VARIANTS')!
    expect(planIncludes('PRO', entry)).toBe(true)
    expect(planIncludes('PREMIUM', entry)).toBe(true)
    expect(entry.minimumTier).not.toBe('FREE')
    expect((FREE_TIER_CODES as readonly string[]).includes(entry.featureCode!)).toBe(false)
  })
})
