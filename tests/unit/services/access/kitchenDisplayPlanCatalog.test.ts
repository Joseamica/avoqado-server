/**
 * KITCHEN_DISPLAY (pantalla de cocina) y CUSTOMER_DISPLAY_PROMOS (promos de la pantalla del cliente): Pro desde antes, pero
 * SIN entrada en FEATURE_CATALOG (D4, founder 31-oct-2026). La oferta de un plan nuevo (HybridContract) sólo se publica con
 * códigos del catálogo, y un negocio cuyo Pro viene de ese contrato sólo recibe lo que el contrato trae como CapabilityGrant:
 * sin la entrada, nunca recibía estas dos. El arreglo es el catálogo; los resolvers no cambian.
 *
 * Cadena que recorre el código: catálogo → `compileHybridPublication` (oferta) → contrato (`featureCodes`) → CapabilityGrant
 * vigente → `venueHasFeatureAccess`. Los dos primeros eslabones son los que estaban rotos; el último se fija aquí con un grant.
 * Molde: deviceMenusPlan.test.ts.
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
  elPlanConcede,
  FREE_TIER_CODES,
  PREMIUM_ONLY_CODES,
  PREMIUM_ONLY_SIN_CATALOGO,
  venueHasFeatureAccess,
} from '../../../../src/services/access/basePlan.service'
import { compileHybridPublication } from '../../../../src/services/launchCampaigns/hybridOffer.service'
import { PLAN_CATCH_UP_CODES } from '../../../../src/services/launchCampaigns/hybridPlanCatchUp'

const db = prisma as any
const TERMS = {
  currency: 'MXN',
  interval: 'MONTHLY',
  price: 999,
  taxIncluded: true,
  promotionCycles: null,
  renewal: { kind: 'SAME_PRICE' },
} as const

const CASOS = [
  {
    codigo: 'KITCHEN_DISPLAY',
    category: 'sell',
    names: { es: 'Pantalla de cocina', en: 'Kitchen display', fr: 'Écran de cuisine' },
    description: 'Las comandas llegan a una pantalla en cada estación de la cocina.',
  },
  {
    codigo: 'CUSTOMER_DISPLAY_PROMOS',
    category: 'customers',
    names: {
      es: 'Promociones en la pantalla del cliente',
      en: 'Customer display promotions',
      fr: "Promotions sur l'écran client",
    },
    description: 'Muestra tus promociones en la pantalla del cliente mientras no hay una venta en curso.',
  },
]

beforeEach(() => {
  jest.clearAllMocks()
  db.capabilityGrant.findFirst.mockResolvedValue(null)
})

describe.each(CASOS)('$codigo en los planes con contrato nuevo', ({ codigo, category, names, description }) => {
  it('🔴 sigue siendo Pro: Pro y Premium la conceden, y no es Premium-only ni promesa del plan gratis', () => {
    expect(elPlanConcede('PRO', codigo)).toBe(true)
    expect(elPlanConcede('PREMIUM', codigo)).toBe(true)
    expect(PREMIUM_ONLY_CODES).not.toContain(codigo)
    expect(PREMIUM_ONLY_SIN_CATALOGO).not.toContain(codigo)
    expect(FREE_TIER_CODES).not.toContain(codigo)
  })

  it('tiene entrada en el catálogo: Pro, configurable, sin requisito, con sus tres nombres', () => {
    expect(FEATURE_CATALOG.find(f => f.featureCode === codigo)).toMatchObject({
      id: codigo,
      featureCode: codigo,
      name: names.es,
      description,
      category,
      minimumTier: 'PRO',
      offering: 'CONFIGURABLE',
      requirement: null,
      names,
    })
  })

  it.each(['PRO', 'PREMIUM'] as const)('🔴 una oferta de plan %s publicada hoy la incluye (si no, el contrato nunca la trae)', planTier => {
    expect(compileHybridPublication({ schemaVersion: 1, kind: 'PLAN', planTier, terms: TERMS }).includedFeatureCodes).toContain(codigo)
  })

  it('está en la lista cerrada de la puesta al día de los contratos vivos', () => {
    expect(PLAN_CATCH_UP_CODES).toContain(codigo)
  })

  it('un negocio sin plan clásico pero con el CapabilityGrant vigente del contrato la tiene; sin grant, no', async () => {
    db.venue.findUnique.mockResolvedValue({ id: 'v1', seatCapExempt: false, organization: { seatCapExempt: false }, status: 'ACTIVE' })
    db.venueFeature.findFirst.mockResolvedValue(null)
    db.venueFeature.findMany.mockResolvedValue([])
    await expect(venueHasFeatureAccess('v1', codigo)).resolves.toBe(false)
    db.capabilityGrant.findFirst.mockResolvedValue({ id: 'g1' })
    await expect(venueHasFeatureAccess('v1', codigo)).resolves.toBe(true)
  })
})
