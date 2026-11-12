/**
 * D5 · bloque P (11-nov-2026): `MESAS_SIN_RED` es el interruptor del piloto «cobrar mesas sin internet». La concede SÓLO el
 * superadmin, negocio por negocio. ANDROID la lee de `grantedFeatureCodes` (payload del plan) y falla cerrado.
 *
 * 🔴 ESTE TEST EXISTE PARA QUE FALLE si alguien mete el código en una lista que lo conceda por plan, por el plan gratis o por el
 * catálogo comercial, o si `grantedFeatureCodes` empieza a heredarlo por exención, prueba (TRIAL) o demo (LIVE_DEMO): cualquiera
 * de esas puertas prendería el piloto en negocios que Avoqado no eligió (rulings-r5.md, R5-2 y R5-3).
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
    capabilityGrant: { findFirst: jest.fn().mockResolvedValue(null), groupBy: jest.fn().mockResolvedValue([]) },
    hybridContract: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { FEATURE_CATALOG } from '../../../../src/config/featureCatalog'
import {
  CODIGOS_DE_PILOTO,
  elPlanConcede,
  FREE_TIER_CODES,
  getVenuePlanInfo,
  PREMIUM_ONLY_CODES,
  PREMIUM_ONLY_SIN_CATALOGO,
} from '../../../../src/services/access/basePlan.service'

const CODIGO = 'MESAS_SIN_RED'
const db = prisma as any
const VIGENTE = { active: true, suspendedAt: null, endDate: null }

/** Un negocio con, a lo más, un plan clásico, una exención, un estado de demo y/o la concesión individual del piloto. */
function sede({
  plan = null as null | 'PLAN_PRO' | 'PLAN_PREMIUM',
  exenta = false,
  orgExenta = false,
  status = 'ACTIVE',
  concedida = false,
} = {}) {
  db.venue.findUnique.mockResolvedValue({ id: 'v1', seatCapExempt: exenta, organization: { seatCapExempt: orgExenta }, status })
  db.venueFeature.findMany.mockImplementation(async ({ where }: any) => {
    if (where?.feature?.code?.in) return plan && where.feature.code.in.includes(plan) ? [{ ...VIGENTE, feature: { code: plan } }] : []
    // Las funciones individuales vigentes (`getVenueGrantedFeatureCodes`): sólo la fila real del piloto si se concedió.
    return concedida ? [{ feature: { code: CODIGO } }] : []
  })
}

beforeEach(() => jest.clearAllMocks())

describe('MESAS_SIN_RED no entra por ningún plan ni catálogo', () => {
  it('🔴 es el único código de piloto y no está en ninguna lista que conceda por plan', () => {
    expect(CODIGOS_DE_PILOTO).toEqual([CODIGO])
    expect(PREMIUM_ONLY_CODES).not.toContain(CODIGO)
    expect(PREMIUM_ONLY_SIN_CATALOGO).not.toContain(CODIGO)
    expect(FREE_TIER_CODES).not.toContain(CODIGO)
    expect(FEATURE_CATALOG.some(f => f.featureCode === CODIGO || f.id === CODIGO)).toBe(false)
  })

  it('ni Pro ni Premium la conceden', () => {
    expect(elPlanConcede('PRO', CODIGO)).toBe(false)
    expect(elPlanConcede('PREMIUM', CODIGO)).toBe(false)
  })
})

describe('grantedFeatureCodes (lo que lee la app) sólo la trae con la concesión real', () => {
  it.each([
    ['Premium de siempre', { plan: 'PLAN_PREMIUM' as const }],
    ['negocio exento', { exenta: true }],
    ['organización exenta', { orgExenta: true }],
    ['prueba (TRIAL)', { status: 'TRIAL' }],
    ['demo en vivo (LIVE_DEMO)', { status: 'LIVE_DEMO' }],
  ])('🔴 %s sin concesión → no la trae', async (_caso, config) => {
    sede(config)
    const info = await getVenuePlanInfo('v1')
    expect(info.grantedFeatureCodes).not.toContain(CODIGO)
  })

  it.each([
    ['negocio sin plan', {}],
    ['negocio exento', { exenta: true }],
    ['demo en vivo (LIVE_DEMO)', { status: 'LIVE_DEMO' }],
  ])('%s con la concesión individual del superadmin → la trae', async (_caso, config) => {
    sede({ ...config, concedida: true })
    const info = await getVenuePlanInfo('v1')
    expect(info.accessSchemaVersion).toBe(1)
    expect(info.grantedFeatureCodes).toContain(CODIGO)
  })
})
