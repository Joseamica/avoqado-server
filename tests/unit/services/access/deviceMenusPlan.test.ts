/**
 * Menú del aparato (DEVICE_MENUS) — función del plan PRO, INCLUIDA y SIN precio suelto (founder, 30-oct-2026).
 *
 * 🔴 ESTE TEST EXISTE PARA QUE FALLE si alguien mueve DEVICE_MENUS de plan o la deja fuera de la lista explícita del plan
 * (`LEGACY_PLAN_CODES`): fuera de esa lista `elPlanConcede` la niega a TODOS, también a Premium, y las tareas que la gatean
 * (la regla del aparato, el PUT del dashboard y el MCP) dejarían sin la función a quien ya la tiene incluida. Va en Pro y
 * NO en `PREMIUM_ONLY_CODES` (se la quitaría a los Pro). Mismo molde que productVariantsTierMirror, giftCardsFeature y
 * customerDisplayPromosAccess.
 *
 * Qué se ancla aquí:
 *  1. quién la concede: Pro y Premium por su plan; Gratis no (salvo una exención de la sede);
 *  2. su entrada en el catálogo: Pro, CONFIGURABLE y sin requisito, y un plan publicado desde hoy la incluye;
 *  3. que entre a los contratos de plan que ya están vivos (`PLAN_CATCH_UP_CODES`);
 *  (La siembra de la fila `Feature` y de los contratos vivos, con precio 0, tiene su propia prueba:
 *  tests/unit/scripts/seedDeviceMenusFeature.test.ts.)
 *
 * «Gratis» se prueba a nivel de NEGOCIO (sin plan): `elPlanConcede` sólo recibe PRO o PREMIUM (`BaseTier`) y, llamada con
 * otra cosa, contestaría como Pro.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
    // Cobro híbrido: sin concesiones sueltas ni contrato de plan; el acceso sale sólo del plan clásico.
    // `groupBy` lo usa `getVenuePlanInfo` (vía `grantedCapabilityCodes`): sin concesiones sueltas devuelve [].
    capabilityGrant: { findFirst: jest.fn().mockResolvedValue(null), groupBy: jest.fn().mockResolvedValue([]) },
    hybridContract: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))

import fs from 'fs'
import path from 'path'
import prisma from '../../../../src/utils/prismaClient'
import { FEATURE_CATALOG } from '../../../../src/config/featureCatalog'
import {
  elPlanConcede,
  FREE_TIER_CODES,
  getVenuePlanInfo,
  PREMIUM_ONLY_CODES,
  PREMIUM_ONLY_SIN_CATALOGO,
  venueHasFeatureAccess,
} from '../../../../src/services/access/basePlan.service'
import { compileHybridPublication, planIncludes } from '../../../../src/services/launchCampaigns/hybridOffer.service'
import { PLAN_CATCH_UP_CODES } from '../../../../src/services/launchCampaigns/hybridPlanCatchUp'

const CODIGO = 'DEVICE_MENUS'
const db = prisma as any
const findFirst = db.venueFeature.findFirst as jest.Mock
const findMany = db.venueFeature.findMany as jest.Mock
const venueFindUnique = db.venue.findUnique as jest.Mock
const VIGENTE = { active: true, suspendedAt: null, endDate: null }

/** Un negocio normal (no demo) con, a lo más, un plan clásico activo o una exención. */
function sede({ plan = null as null | 'PLAN_PRO' | 'PLAN_PREMIUM', exenta = false } = {}) {
  venueFindUnique.mockResolvedValue({ id: 'v1', seatCapExempt: exenta, organization: { seatCapExempt: false }, status: 'ACTIVE' })
  findFirst.mockResolvedValue(null) // sin acceso propio del código consultado
  findMany.mockImplementation(async ({ where }: any) =>
    plan && where?.feature?.code?.in?.includes(plan) ? [{ ...VIGENTE, feature: { code: plan } }] : [],
  )
}

beforeEach(() => jest.clearAllMocks())

describe('DEVICE_MENUS es función del plan Pro (founder, 30-oct)', () => {
  it('🔴 no es diferenciador Premium, ni promesa del plan gratis', () => {
    // Va en LEGACY_PLAN_CODES, NUNCA en PREMIUM_ONLY_CODES: ahí se la quitaría a los Pro.
    expect(PREMIUM_ONLY_CODES).not.toContain(CODIGO)
    expect(PREMIUM_ONLY_SIN_CATALOGO).not.toContain(CODIGO)
    expect(FREE_TIER_CODES).not.toContain(CODIGO)
  })

  it('Pro y Premium la conceden', () => {
    expect(elPlanConcede('PRO', CODIGO)).toBe(true)
    expect(elPlanConcede('PREMIUM', CODIGO)).toBe(true)
  })

  it.each([
    ['Pro de siempre', { plan: 'PLAN_PRO' as const }, true],
    ['Premium de siempre', { plan: 'PLAN_PREMIUM' as const }, true],
    ['Gratis (sin plan)', {}, false],
    ['sede exenta (grandfathered)', { exenta: true }, true],
  ])('venueHasFeatureAccess — %s → %s', async (_caso, config, esperado) => {
    sede(config)
    await expect(venueHasFeatureAccess('v1', CODIGO)).resolves.toBe(esperado)
  })

  it('un negocio PRO la recibe en `grantedFeatureCodes` del payload del plan (lo que leen las apps); uno sin plan no', async () => {
    sede({ plan: 'PLAN_PRO' })
    const pro = await getVenuePlanInfo('v1')
    expect(pro.tier).toBe('PRO')
    expect(pro.grantedFeatureCodes).toContain(CODIGO)

    sede()
    const gratis = await getVenuePlanInfo('v1')
    expect(gratis.tier).toBe('FREE')
    expect(gratis.grantedFeatureCodes).not.toContain(CODIGO)
  })
})

describe('DEVICE_MENUS en el catálogo de funciones', () => {
  it('está como función de Pro, configurable, sin requisito, y con sus tres nombres', () => {
    expect(FEATURE_CATALOG.find(f => f.featureCode === CODIGO)).toMatchObject({
      id: CODIGO,
      featureCode: CODIGO,
      name: 'Menú de cada aparato',
      category: 'sell',
      minimumTier: 'PRO',
      offering: 'CONFIGURABLE',
      requirement: null,
      names: { es: 'Menú de cada aparato', en: 'Menu per device', fr: 'Menu par appareil' },
    })
  })

  it('su descripción promete lo que sí hace la regla: la búsqueda y el escáner siguen encontrando todo', () => {
    expect(FEATURE_CATALOG.find(f => f.featureCode === CODIGO)?.description).toMatch(/búsqueda y el escáner siguen encontrando todo/)
  })

  it('🔴 un plan PRO o PREMIUM la incluye; FREE no: planIncludes sólo mete FREE o CONFIGURABLE de ese plan', () => {
    const entrada = FEATURE_CATALOG.find(f => f.featureCode === CODIGO)
    expect(entrada).toBeDefined()
    expect(planIncludes('PRO', entrada!)).toBe(true)
    expect(planIncludes('PREMIUM', entrada!)).toBe(true)
    expect(entrada!.minimumTier).not.toBe('FREE')
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
    expect(compileHybridPublication({ schemaVersion: 1, kind: 'PLAN', planTier, terms }).includedFeatureCodes).toContain(CODIGO)
  })
})

describe('DEVICE_MENUS en los contratos de plan que ya están vivos', () => {
  it('está en la lista cerrada de la puesta al día, y los DOS planes la conceden (lo que exige la guarda)', () => {
    expect(PLAN_CATCH_UP_CODES).toContain(CODIGO)
    expect(elPlanConcede('PRO', CODIGO) && elPlanConcede('PREMIUM', CODIGO)).toBe(true)
  })
})

describe('🔴 DEVICE_MENUS tiene UN solo resolver: el de funciones del plan (nunca el de módulos)', () => {
  const SRC = path.join(__dirname, '../../../../src')
  const archivos = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? archivos(full) : e.name.endsWith('.ts') ? [full] : []
    })

  it('ningún archivo resuelve DEVICE_MENUS con el resolver de módulos', () => {
    const MODULO =
      /MODULE_CODES\.DEVICE_MENUS|(?:isModuleEnabled|venuesWithModule|anyVenueHasModule|getModuleConfig|enableModule|disableModule)\([^)]*['"]DEVICE_MENUS['"]/
    const culpables = archivos(SRC)
      .filter(f => MODULO.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(SRC, f))
    expect(culpables).toEqual([])
  })
})
