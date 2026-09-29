/**
 * Pantalla de cocina — espejo de tiers (decisión D-A del 27-sep: plan Pro, con lo de sin internet incluido).
 *
 * 🔴 ESTE TEST EXISTE PARA QUE FALLE SI ALGUIEN MUEVE KITCHEN_DISPLAY DE TIER. `basePlan.service.ts` sólo enumera
 * los diferenciadores PREMIUM (`PREMIUM_ONLY_CODES`) y las promesas del plan gratis (`FREE_TIER_CODES`). Desde el cobro
 * híbrido (29-sep) PRO ya NO es blanket: concede sólo su lista explícita (`LEGACY_PLAN_CODES`), así que KITCHEN_DISPLAY
 * tiene que estar ahí. Mismo patrón que areaTicketsTierMirror.
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
import { FREE_TIER_CODES, PREMIUM_ONLY_CODES, venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'

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

describe('espejo de tiers — pantalla de cocina (etapa 3)', () => {
  it('🔴 KITCHEN_DISPLAY no es Premium ni gratis: es de la lista de PRO', () => {
    expect(PREMIUM_ONLY_CODES).not.toContain('KITCHEN_DISPLAY')
    expect(FREE_TIER_CODES).not.toContain('KITCHEN_DISPLAY')
  })

  it('un negocio PRO la tiene', async () => {
    mockTierVenue('PLAN_PRO')
    await expect(venueHasFeatureAccess('v1', 'KITCHEN_DISPLAY')).resolves.toBe(true)
  })

  it('un negocio SIN plan no', async () => {
    venueFindUnique.mockResolvedValue({ id: 'v1', seatCapExempt: false, status: 'ACTIVE' })
    findFirst.mockResolvedValue(null)
    findMany.mockResolvedValue([])
    await expect(venueHasFeatureAccess('v1', 'KITCHEN_DISPLAY')).resolves.toBe(false)
  })
})
