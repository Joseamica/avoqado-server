/**
 * Tarjetas de regalo (GIFT_CARDS) — función del plan PRO; suelta a $249 al mes con IVA (founder D1, 14-oct-2026; spec §9).
 *
 * 🔴 EXISTE PARA QUE FALLE si alguien la mueve de plan o la deja fuera de `LEGACY_PLAN_CODES`: fuera de esa lista
 * `elPlanConcede` la niega a TODOS (mismo molde que servicePayFeature.test.ts).
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

import fs from 'fs'
import path from 'path'
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

describe('GIFT_CARDS es función del plan Pro (D1)', () => {
  it('Pro y Premium la conceden; no es diferenciador Premium ni promesa del plan gratis', () => {
    expect(elPlanConcede('PRO', 'GIFT_CARDS')).toBe(true)
    expect(elPlanConcede('PREMIUM', 'GIFT_CARDS')).toBe(true)
    expect(PREMIUM_ONLY_CODES).not.toContain('GIFT_CARDS')
    expect(FREE_TIER_CODES).not.toContain('GIFT_CARDS')
  })

  it.each([
    ['Pro de siempre', { plan: 'PLAN_PRO' as const }, true],
    ['Premium de siempre', { plan: 'PLAN_PREMIUM' as const }, true],
    ['Gratis (sin plan)', {}, false],
    ['sede exenta', { exenta: true }, true],
    ['suelta ($249 al mes: un acceso de función)', { suelta: true }, true],
  ])('%s → %s', async (_caso, config, esperado) => {
    sede(config)
    await expect(venueHasFeatureAccess('v1', 'GIFT_CARDS')).resolves.toBe(esperado)
  })

  it('está en el catálogo como función de clientes, de Pro, que se vende suelta con precio de lista', () => {
    expect(FEATURE_CATALOG.find(f => f.featureCode === 'GIFT_CARDS')).toMatchObject({
      id: 'GIFT_CARDS',
      name: 'Tarjetas de regalo',
      category: 'customers',
      minimumTier: 'PRO',
      offering: 'CONFIGURABLE',
      requirement: null,
      names: { es: 'Tarjetas de regalo', en: 'Gift cards', fr: 'Cartes cadeaux' },
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
    expect(compileHybridPublication({ schemaVersion: 1, kind: 'PLAN', planTier, terms }).includedFeatureCodes).toContain('GIFT_CARDS')
  })
})

describe('🔴 GIFT_CARDS tiene UN solo resolver: el de funciones del plan', () => {
  const SRC = path.join(__dirname, '../../../../src')
  const archivos = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? archivos(full) : e.name.endsWith('.ts') ? [full] : []
    })

  it('ningún archivo resuelve GIFT_CARDS con el resolver de módulos', () => {
    const MODULO =
      /MODULE_CODES\.GIFT_CARDS|(?:isModuleEnabled|venuesWithModule|anyVenueHasModule|getModuleConfig|enableModule|disableModule)\([^)]*['"]GIFT_CARDS['"]/
    const culpables = archivos(SRC)
      .filter(f => MODULO.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f))
    expect(culpables).toEqual([])
  })
})
