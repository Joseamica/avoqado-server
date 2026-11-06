/**
 * D4 + D6 (5-nov-2026): el portero decide con la regla única (`ventanaDeAcceso.ts`).
 *
 * Antes: una prueba con tarjeta cuyo primer cobro fallaba tenía «gracia» en la base pero el portero la negaba desde el
 * día 0 (la prueba ya había vencido), y una gracia vencida sobre un plan pagado seguía abriendo rutas hasta que llegaba
 * el 4.º intento de Stripe.
 *
 * Usa el resolver REAL (sólo se simula la base), como `checkFeatureAccess.planCubre.test.ts`.
 */
const mockVfFindFirst = jest.fn()
const mockVfFindMany = jest.fn()
const mockVenueFindUnique = jest.fn()
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    capabilityGrant: { findFirst: jest.fn().mockResolvedValue(null), groupBy: jest.fn().mockResolvedValue([]) },
    venueFeature: {
      findFirst: (...a: unknown[]) => mockVfFindFirst(...a),
      findMany: (...a: unknown[]) => mockVfFindMany(...a),
    },
    venue: { findUnique: (...a: unknown[]) => mockVenueFindUnique(...a) },
    staffVenue: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}))
jest.mock('./../../../src/middlewares/checkPermission.middleware', () => ({
  resolveRequestVenueId: () => 'venue-1',
}))

import { checkAnyFeatureAccess, checkFeatureAccess, hasFeatureAccess } from '@/middlewares/checkFeatureAccess.middleware'

const DIA = 86_400_000
const ayer = new Date(Date.now() - DIA)
const manana = new Date(Date.now() + DIA)
const haceUnaSemana = new Date(Date.now() - 7 * DIA)

type Ventana = { endDate: Date | null; suspendedAt: Date | null; gracePeriodEndsAt: Date | null }

/** La fila del PLAN del negocio (la que lee getVenueBaseTier). */
function plan(code: 'PLAN_PRO' | null, v: Partial<Ventana> = {}) {
  mockVfFindMany.mockResolvedValue(
    code ? [{ active: true, suspendedAt: null, endDate: null, gracePeriodEndsAt: null, ...v, feature: { code } }] : [],
  )
}

async function correr(featureCode: string, filaPropia: (Partial<Ventana> & { active?: boolean }) | null) {
  mockVfFindFirst.mockResolvedValue(
    filaPropia
      ? {
          active: true,
          endDate: null,
          suspendedAt: null,
          gracePeriodEndsAt: null,
          ...filaPropia,
          feature: { code: featureCode, name: featureCode },
        }
      : null,
  )
  const req: any = { authContext: { userId: 'staff-1' }, params: { venueId: 'venue-1' } }
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
  const next = jest.fn()
  await checkFeatureAccess(featureCode)(req, res, next)
  return { paso: next.mock.calls.length > 0, status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockVenueFindUnique.mockResolvedValue({ seatCapExempt: false, organization: { seatCapExempt: false }, status: 'ACTIVE' })
})

describe('el PLAN en cobranza (lo que cubre por tier)', () => {
  it('🔴 D6: prueba vencida + primer cobro fallido con gracia vigente → el plan sigue abriendo sus rutas', async () => {
    plan('PLAN_PRO', { endDate: ayer, gracePeriodEndsAt: manana })
    expect(await correr('RESERVATIONS', null)).toMatchObject({ paso: true })
  })

  it('🔴 vencidos los 4 días tras la prueba → el plan ya NO abre sus rutas', async () => {
    plan('PLAN_PRO', { endDate: ayer, gracePeriodEndsAt: ayer })
    expect(await correr('RESERVATIONS', null)).toMatchObject({ paso: false, status: 403 })
  })

  it('REGRESIÓN v4: quien ya pagaba con la gracia vencida y aún sin suspender → sigue abriendo (lo corta el 4.º intento)', async () => {
    plan('PLAN_PRO', { gracePeriodEndsAt: ayer })
    expect(await correr('RESERVATIONS', null)).toMatchObject({ paso: true })
  })

  it('REGRESIÓN: plan pagado sin cobranza → pasa', async () => {
    plan('PLAN_PRO')
    expect(await correr('RESERVATIONS', null)).toMatchObject({ paso: true })
  })

  it('REGRESIÓN: prueba vencida sin gracia → bloqueado', async () => {
    plan('PLAN_PRO', { endDate: ayer })
    expect(await correr('RESERVATIONS', null)).toMatchObject({ paso: false, status: 403 })
  })
})

describe('una función SUELTA en cobranza (fila propia)', () => {
  it('🔴 D6: prueba vencida + gracia vigente → pasa', async () => {
    plan(null)
    expect(await correr('INVENTORY_TRACKING', { endDate: ayer, gracePeriodEndsAt: manana })).toMatchObject({ paso: true })
  })

  it('🔴 vencidos los 4 días → 403 «suspendida por falta de pago», con la fecha de la gracia', async () => {
    plan(null)
    const r = await correr('INVENTORY_TRACKING', { endDate: ayer, gracePeriodEndsAt: ayer })
    expect(r).toMatchObject({ paso: false, status: 403 })
    expect(r.body).toMatchObject({ suspended: true, gracePeriodEndsAt: ayer })
  })

  it('REGRESIÓN: prueba vencida sin gracia → 403 «prueba vencida»', async () => {
    plan(null)
    const r = await correr('INVENTORY_TRACKING', { endDate: ayer })
    expect(r).toMatchObject({ paso: false, status: 403 })
    expect(r.body).toMatchObject({ trialExpired: true })
  })

  it('REGRESIÓN: suspendida → 403 «suspendida»', async () => {
    plan(null)
    const r = await correr('INVENTORY_TRACKING', { suspendedAt: haceUnaSemana })
    expect(r.body).toMatchObject({ suspended: true })
  })
})

describe('hasFeatureAccess (lo usa el reductor sin red de las apps)', () => {
  it('🔴 D6: suelta con prueba vencida + gracia vigente → con acceso', async () => {
    plan(null)
    mockVfFindFirst.mockResolvedValue({
      active: true,
      endDate: ayer,
      suspendedAt: null,
      gracePeriodEndsAt: manana,
      feature: { code: 'PROMOTIONS' },
    })
    await expect(hasFeatureAccess('venue-1', 'INVENTORY_TRACKING')).resolves.toMatchObject({ hasAccess: true })
  })

  it('🔴 vencidos los 4 días → sin acceso', async () => {
    plan(null)
    mockVfFindFirst.mockResolvedValue({
      active: true,
      endDate: ayer,
      suspendedAt: null,
      gracePeriodEndsAt: ayer,
      feature: { code: 'PROMOTIONS' },
    })
    await expect(hasFeatureAccess('venue-1', 'INVENTORY_TRACKING')).resolves.toMatchObject({ hasAccess: false })
  })
})

describe('checkAnyFeatureAccess', () => {
  it('🔴 de varias filas gana la que SÍ da acceso, aunque otra vencida salga primero', async () => {
    mockVfFindMany.mockResolvedValue([
      { id: 'a', active: true, endDate: ayer, suspendedAt: null, gracePeriodEndsAt: null, feature: { code: 'A', name: 'A' } },
      { id: 'b', active: true, endDate: ayer, suspendedAt: null, gracePeriodEndsAt: manana, feature: { code: 'B', name: 'B' } },
    ])
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }
    const next = jest.fn()
    await checkAnyFeatureAccess(['A', 'B'])({ authContext: { userId: 's' }, params: { venueId: 'venue-1' } } as any, res, next)
    expect(next).toHaveBeenCalled()
  })
})
