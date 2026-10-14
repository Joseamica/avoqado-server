/**
 * Pantalla del cliente — promos en reposo (CUSTOMER_DISPLAY_PROMOS): función del plan PRO (founder, spec §5.8).
 *
 * 🔴 ESTE TEST EXISTE PARA QUE FALLE SI ALGUIEN MUEVE CUSTOMER_DISPLAY_PROMOS DE TIER o la deja fuera de la lista
 * explícita del plan (`LEGACY_PLAN_CODES`). Desde el cobro híbrido (29-sep) PRO ya NO es blanket: `elPlanConcede` sólo
 * concede lo que está en esa lista, y un código que no aparece se le niega a TODOS (incluido PREMIUM). Mismo patrón que
 * el precedente KITCHEN_DISPLAY (`kitchenDisplayTierMirror.test.ts`): un código de PRO sin fila `Feature` ni entrada en
 * `FEATURE_CATALOG` (esa fila llega en F3), por lo que NO va en `PREMIUM_ONLY_CODES` ni en `FREE_TIER_CODES`.
 *
 * Qué se ancla aquí: PRO y PREMIUM lo conceden por su plan; FREE (sin plan) no, salvo un acceso propio vigente
 * (`VenueFeature`) o una exención (`seatCapExempt`). Ninguna de estas pruebas toca Stripe.
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

import prisma from '../../../../src/utils/prismaClient'
import {
  elPlanConcede,
  FREE_TIER_CODES,
  getVenuePlanInfo,
  PREMIUM_ONLY_CODES,
  venueHasFeatureAccess,
} from '../../../../src/services/access/basePlan.service'
import { FEATURE_CATALOG } from '../../../../src/config/featureCatalog'

const CODIGO = 'CUSTOMER_DISPLAY_PROMOS'
const db = prisma as any
const findFirst = db.venueFeature.findFirst as jest.Mock
const findMany = db.venueFeature.findMany as jest.Mock
const venueFindUnique = db.venue.findUnique as jest.Mock
const VIGENTE = { active: true, suspendedAt: null, endDate: null }

/** Un venue normal (no demo) con, a lo más, un plan clásico activo, un acceso propio del código o una exención. */
function sede({
  plan = null as null | 'PLAN_PRO' | 'PLAN_PREMIUM',
  propio = false,
  exenta = false,
}: { plan?: null | 'PLAN_PRO' | 'PLAN_PREMIUM'; propio?: boolean; exenta?: boolean } = {}) {
  venueFindUnique.mockResolvedValue({ id: 'v1', seatCapExempt: exenta, organization: { seatCapExempt: false }, status: 'ACTIVE' })
  findFirst.mockResolvedValue(propio ? { ...VIGENTE } : null) // acceso propio del código consultado
  findMany.mockImplementation(async ({ where }: any) =>
    plan && where?.feature?.code?.in?.includes(plan) ? [{ ...VIGENTE, feature: { code: plan } }] : [],
  )
}

beforeEach(() => jest.clearAllMocks())

describe('pantalla del cliente — promos en reposo: espejo de tiers (F0-A)', () => {
  it('🔴 CUSTOMER_DISPLAY_PROMOS no es Premium ni gratis: es de la lista de PRO', () => {
    expect(PREMIUM_ONLY_CODES).not.toContain(CODIGO)
    expect(FREE_TIER_CODES).not.toContain(CODIGO)
    expect(elPlanConcede('PRO', CODIGO)).toBe(true)
  })

  it('🔴 no está en FEATURE_CATALOG todavía', () => {
    // Decisión del founder: sin catálogo ni fila Feature hasta F3; F3 voltea esta aserción.
    expect(FEATURE_CATALOG.some(e => e.featureCode === CODIGO)).toBe(false)
  })

  it('un negocio PRO la tiene', async () => {
    sede({ plan: 'PLAN_PRO' })
    await expect(venueHasFeatureAccess('v1', CODIGO)).resolves.toBe(true)
  })

  it('un negocio PRO la recibe en `grantedFeatureCodes` del payload del plan (lo que leen las apps)', async () => {
    sede({ plan: 'PLAN_PRO' })
    const info = await getVenuePlanInfo('v1')
    expect(info.tier).toBe('PRO')
    expect(info.grantedFeatureCodes).toContain(CODIGO)
  })

  it('un negocio SIN plan NO la recibe en `grantedFeatureCodes`', async () => {
    sede()
    const info = await getVenuePlanInfo('v1')
    expect(info.tier).toBe('FREE')
    expect(info.grantedFeatureCodes).not.toContain(CODIGO)
  })

  it('un negocio PREMIUM la tiene', async () => {
    sede({ plan: 'PLAN_PREMIUM' })
    await expect(venueHasFeatureAccess('v1', CODIGO)).resolves.toBe(true)
  })

  it('un negocio SIN plan no', async () => {
    sede()
    await expect(venueHasFeatureAccess('v1', CODIGO)).resolves.toBe(false)
  })

  it('un negocio SIN plan pero con su propio acceso vigente (VenueFeature) sí', async () => {
    sede({ propio: true })
    await expect(venueHasFeatureAccess('v1', CODIGO)).resolves.toBe(true)
    // El acceso propio se busca por ESTE código exacto, no por otro parecido.
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'v1', feature: { code: CODIGO } } }))
  })

  it('un negocio SIN plan pero exento (seatCapExempt) sí', async () => {
    sede({ exenta: true })
    await expect(venueHasFeatureAccess('v1', CODIGO)).resolves.toBe(true)
  })
})
