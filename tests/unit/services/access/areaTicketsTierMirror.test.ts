/**
 * Vales por área + báscula — espejo de tiers (§2, §10).
 *
 * 🔴 ESTE TEST EXISTE PARA QUE FALLE SI ALGUIEN MUEVE UN CÓDIGO DE TIER.
 *
 * `basePlan.service.ts` **sólo enumera** los diferenciadores PREMIUM
 * (`PREMIUM_ONLY_CODES`) y las promesas del plan gratis (`FREE_TIER_CODES`). **PRO es
 * BLANKET**: cualquier código que NO esté en esas dos listas queda incluido en PRO.
 *
 * De los tres códigos del spec:
 *   · `AREA_TICKETS`            → **PRO** (online-only, declarado como tal)
 *   · `VARIABLE_WEIGHT_BARCODE` → **PRO** (fase 2)
 *   · `SCALE_INTEGRATION`       → **PREMIUM** (va con kit certificado e instalación)
 *
 * Agregar `AREA_TICKETS` o `VARIABLE_WEIGHT_BARCODE` a `PREMIUM_ONLY_CODES` los
 * volvería Premium en silencio y le quitaría a los venues Pro algo que ya se les
 * vendió. La única señal de eso sería un venue Pro recibiendo 403 en el mostrador,
 * con producto de un cliente ya guardado en el área. De ahí este candado.
 */

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
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

describe('espejo de tiers — vales por área y báscula (§2)', () => {
  // ── El candado ────────────────────────────────────────────────────────────────

  it('🔴 SCALE_INTEGRATION está declarado como diferenciador PREMIUM', () => {
    expect(PREMIUM_ONLY_CODES).toContain('SCALE_INTEGRATION')
  })

  it('🔴 AREA_TICKETS NO está en PREMIUM_ONLY_CODES (PRO es blanket: meterlo lo volvería Premium)', () => {
    expect(PREMIUM_ONLY_CODES).not.toContain('AREA_TICKETS')
    expect(FREE_TIER_CODES).not.toContain('AREA_TICKETS')
  })

  it('🔴 VARIABLE_WEIGHT_BARCODE NO está en PREMIUM_ONLY_CODES', () => {
    expect(PREMIUM_ONLY_CODES).not.toContain('VARIABLE_WEIGHT_BARCODE')
    expect(FREE_TIER_CODES).not.toContain('VARIABLE_WEIGHT_BARCODE')
  })

  // ── Lo que eso significa en runtime ───────────────────────────────────────────

  it('un venue PRO SÍ puede usar vales por área', async () => {
    mockTierVenue('PLAN_PRO')
    await expect(venueHasFeatureAccess('v1', 'AREA_TICKETS')).resolves.toBe(true)
  })

  it('un venue PRO NO puede usar la báscula (es el diferenciador Premium)', async () => {
    mockTierVenue('PLAN_PRO')
    await expect(venueHasFeatureAccess('v1', 'SCALE_INTEGRATION')).resolves.toBe(false)
  })

  it('un venue PREMIUM puede usar ambos', async () => {
    mockTierVenue('PLAN_PREMIUM')
    await expect(venueHasFeatureAccess('v1', 'AREA_TICKETS')).resolves.toBe(true)
    await expect(venueHasFeatureAccess('v1', 'SCALE_INTEGRATION')).resolves.toBe(true)
  })

  it('un venue SIN plan (FREE) no puede abrir vales por área', async () => {
    venueFindUnique.mockResolvedValue({ id: 'v1', seatCapExempt: false, status: 'ACTIVE' })
    findFirst.mockResolvedValue(null)
    findMany.mockResolvedValue([])
    await expect(venueHasFeatureAccess('v1', 'AREA_TICKETS')).resolves.toBe(false)
  })

  it('un venue PRO con grant propio de báscula la conserva (grandfather à-la-carte)', async () => {
    venueFindUnique.mockResolvedValue({ id: 'v1', seatCapExempt: false, status: 'ACTIVE' })
    findFirst.mockResolvedValue(ACTIVE) // grant explícito de SCALE_INTEGRATION
    findMany.mockImplementation(async ({ where }: any) => {
      const { list } = codeFilter(where)
      if (list && list.includes('PLAN_PRO')) return [{ ...ACTIVE, feature: { code: 'PLAN_PRO' } }]
      return []
    })
    await expect(venueHasFeatureAccess('v1', 'SCALE_INTEGRATION')).resolves.toBe(true)
  })
})
