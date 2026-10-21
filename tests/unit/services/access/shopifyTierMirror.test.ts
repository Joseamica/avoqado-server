/**
 * Conector Shopify — espejo de tiers (spec 2026-10-07 §12 bis.15: en la Fase 1 NO se vende).
 *
 * 🔴 FALLA SI ALGUIEN MUEVE SHOPIFY_INTEGRATION DE TIER O LO METE AL CATÁLOGO ANTES DE LA FASE 5.
 * Acceso = Premium clásico por regla, cortesía de superadmin (VenueFeature propia), exentos (sucursal u organización) y
 * demo. Pro no. Un contrato Premium COMERCIAL tampoco todavía: su composición quedó congelada sin la función y la política
 * para esos contratos es de la Fase 5 (índice v2 §8). Patrón: kitchenDisplayTierMirror.test.ts.
 */
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn(), findMany: jest.fn() },
    venueFeature: { findFirst: jest.fn(), findMany: jest.fn() },
    capabilityGrant: { findFirst: jest.fn(), groupBy: jest.fn() },
    hybridContract: { findFirst: jest.fn() },
  },
}))

import prisma from '../../../../src/utils/prismaClient'
import { FEATURE_CATALOG } from '../../../../src/config/featureCatalog'
import {
  elPlanConcede,
  PREMIUM_ONLY_CODES,
  PREMIUM_ONLY_SIN_CATALOGO,
  venueHasFeatureAccess,
  venuesWithFeatureAccess,
} from '../../../../src/services/access/basePlan.service'

const CODE = 'SHOPIFY_INTEGRATION'
const AYER = new Date(Date.now() - 86_400_000)
type Fila = { code: string; active: boolean; suspendedAt: Date | null; endDate: Date | null }
type Negocio = { id: string; seatCapExempt: boolean; organization: { seatCapExempt: boolean }; status: string }

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>
let negocios: Negocio[] = []
let filas: Record<string, Fila[]> = {}
let conContratoPremium = new Set<string>()

const fila = (code: string, extra: Partial<Fila> = {}): Fila => ({ code, active: true, suspendedAt: null, endDate: null, ...extra })
const vigente = (f: Fila) => f.active && !f.suspendedAt && (!f.endDate || f.endDate >= new Date())
const codigos = (where: any): string[] => {
  const c = where?.feature?.code
  return typeof c === 'string' ? [c] : (c?.in ?? [])
}

function negocio(
  id: string,
  o: { exento?: boolean; orgExenta?: boolean; status?: string; filas?: Fila[]; contratoPremium?: boolean } = {},
) {
  negocios.push({
    id,
    seatCapExempt: o.exento ?? false,
    organization: { seatCapExempt: o.orgExenta ?? false },
    status: o.status ?? 'ACTIVE',
  })
  filas[id] = o.filas ?? []
  if (o.contratoPremium) conContratoPremium.add(id)
}

beforeEach(() => {
  jest.clearAllMocks()
  negocios = []
  filas = {}
  conContratoPremium = new Set()
  db.venue.findUnique.mockImplementation(async ({ where }: any) => negocios.find(n => n.id === where.id) ?? null)
  db.venue.findMany.mockImplementation(async ({ where }: any) => negocios.filter(n => where.id.in.includes(n.id)))
  // Consulta de UN negocio (sin ventana en el where): la base devuelve la fila y el código revisa si está vigente.
  db.venueFeature.findFirst.mockImplementation(async ({ where }: any) => {
    const f = (filas[where.venueId] ?? []).find(r => codigos(where).includes(r.code))
    return f ? { active: f.active, suspendedAt: f.suspendedAt, endDate: f.endDate } : null
  })
  // Con ventana (`active: true` en el where, consulta por lote o del tier): la base ya filtra lo vencido o suspendido.
  db.venueFeature.findMany.mockImplementation(async ({ where }: any) => {
    const ids: string[] = typeof where.venueId === 'string' ? [where.venueId] : where.venueId.in
    return ids.flatMap(venueId =>
      (filas[venueId] ?? [])
        .filter(r => codigos(where).includes(r.code) && (where.active !== true || vigente(r)))
        .map(r => ({ venueId, active: r.active, suspendedAt: r.suspendedAt, endDate: r.endDate, feature: { code: r.code } })),
    )
  })
  // Un contrato Premium comercial concede SÓLO lo que congeló al publicarse: Shopify no estaba.
  db.capabilityGrant.findFirst.mockImplementation(async ({ where }: any) =>
    conContratoPremium.has(where.venueId) && where.featureCode !== CODE ? { id: 'grant', contract: { planTier: 'PREMIUM' } } : null,
  )
  db.capabilityGrant.groupBy.mockResolvedValue([])
  db.hybridContract.findFirst.mockResolvedValue(null)
})

describe('espejo de tiers — conector Shopify (Fase 1, sin venta)', () => {
  it('🔴 Premium la concede por regla y Pro no', () => {
    expect(elPlanConcede('PREMIUM', CODE)).toBe(true)
    expect(elPlanConcede('PRO', CODE)).toBe(false)
  })

  it('🔴 vive FUERA del catálogo de funciones hasta la Fase 5 (no se lista, no se vende, no entra en ofertas)', () => {
    expect(PREMIUM_ONLY_SIN_CATALOGO).toContain(CODE)
    expect(PREMIUM_ONLY_CODES).not.toContain(CODE)
    const delCatalogo = new Set(FEATURE_CATALOG.map(f => f.featureCode))
    // Si alguien la agrega al catálogo, debe moverla a PREMIUM_ONLY_CODES (y featureCatalog.test.ts lo vigila).
    expect(PREMIUM_ONLY_SIN_CATALOGO.filter(c => delCatalogo.has(c))).toEqual([])
  })

  it.each<[string, () => void, boolean]>([
    ['Premium clásico', () => negocio('v', { filas: [fila('PLAN_PREMIUM')] }), true],
    ['Pro', () => negocio('v', { filas: [fila('PLAN_PRO')] }), false],
    ['sin plan', () => negocio('v'), false],
    ['Premium vencido (prueba sin pagar)', () => negocio('v', { filas: [fila('PLAN_PREMIUM', { endDate: AYER })] }), false],
    ['Premium suspendido (pago fallido)', () => negocio('v', { filas: [fila('PLAN_PREMIUM', { suspendedAt: AYER })] }), false],
    ['Premium comercial (contrato): la política es de la Fase 5', () => negocio('v', { contratoPremium: true }), false],
    ['cortesía de superadmin (VenueFeature propia)', () => negocio('v', { filas: [fila(CODE)] }), true],
    ['cortesía vencida', () => negocio('v', { filas: [fila(CODE, { endDate: AYER })] }), false],
    ['Pro con cortesía', () => negocio('v', { filas: [fila('PLAN_PRO'), fila(CODE)] }), true],
    ['sucursal exenta', () => negocio('v', { exento: true }), true],
    ['organización exenta', () => negocio('v', { orgExenta: true }), true],
    ['demo LIVE_DEMO', () => negocio('v', { status: 'LIVE_DEMO' }), true],
    ['demo TRIAL', () => negocio('v', { status: 'TRIAL' }), true],
  ])('%s', async (_caso, preparar, esperado) => {
    preparar()
    await expect(venueHasFeatureAccess('v', CODE)).resolves.toBe(esperado)
    await expect(venuesWithFeatureAccess(['v'], CODE)).resolves.toEqual(esperado ? new Set(['v']) : new Set())
  })

  it('por lote, cada negocio responde por sí mismo', async () => {
    negocio('premium', { filas: [fila('PLAN_PREMIUM')] })
    negocio('pro', { filas: [fila('PLAN_PRO')] })
    negocio('demo', { status: 'LIVE_DEMO' })
    await expect(venuesWithFeatureAccess(['premium', 'pro', 'demo'], CODE)).resolves.toEqual(new Set(['premium', 'demo']))
  })
})
