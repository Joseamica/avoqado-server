/**
 * D30 (12-nov-2026): cuando el SUPERADMIN prende o apaga una función de un negocio, la bitácora guardaba
 * FEATURE_ENABLED_BY_ADMIN / FEATURE_DISABLED_BY_ADMIN sin QUIÉN (`staffId` vacío) ni QUÉ función (`data` vacío), y con
 * `entityId` = el negocio. El piloto «Mesas: cobrar sin internet» se concede negocio por negocio: hay que poder
 * auditar quién lo prendió y cuál fue.
 */
import { logAction } from '@/services/dashboard/activity-log.service' // mockeado globalmente en setup
import { prismaMock } from '../../../__helpers__/setup'

const mockExigir = jest.fn()
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  exigirSinObligacionViva: (...a: unknown[]) => mockExigir(...a),
}))
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaPorPlanRegalado: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/dashboard/planState.service', () => ({
  __esModule: true,
  getPlanState: jest.fn().mockResolvedValue({ hasPlan: true }),
}))
jest.mock('stripe')

import * as superadminService from '@/services/dashboard/superadmin.service'
import { assignCompPlan, disableFeatureForVenue, enableFeatureForVenue } from '@/services/dashboard/superadmin.service'
import * as superadminController from '@/controllers/dashboard/superadmin.controller'

const MESAS = { id: 'feature-mesas', code: 'MESAS_SIN_RED', monthlyPrice: 0 }
const PRO = { id: 'feature-pro', code: 'PLAN_PRO', monthlyPrice: 1158.84 }
const PREMIUM = { id: 'feature-premium', code: 'PLAN_PREMIUM', monthlyPrice: 2318.84 }

/** El asiento de la bitácora con esa acción (falla si no hay exactamente uno). */
const asiento = (action: string) => {
  const llamadas = (logAction as jest.Mock).mock.calls.map((c: any[]) => c[0]).filter((p: any) => p.action === action)
  expect(llamadas).toHaveLength(1)
  return llamadas[0]
}

beforeEach(() => {
  mockExigir.mockReset().mockResolvedValue(undefined)
  prismaMock.$queryRaw.mockReset().mockResolvedValue([{ id: 'cven1' }] as never)
  prismaMock.$executeRaw.mockReset().mockResolvedValue(0 as never)
  prismaMock.$transaction.mockImplementation(async (cb: (tx: never) => Promise<unknown>) => cb(prismaMock as never))
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'cven1' } as never)
  prismaMock.feature.findUnique.mockResolvedValue(MESAS as never)
  prismaMock.feature.findMany.mockResolvedValue([PRO, PREMIUM] as never)
  prismaMock.venueFeature.upsert.mockResolvedValue({ id: 'vf-mesas', venueId: 'cven1', featureId: MESAS.id } as never)
  prismaMock.venueFeature.findUnique.mockResolvedValue({ id: 'vf-mesas', stripeSubscriptionId: null } as never)
  prismaMock.venueFeature.findMany.mockReset().mockResolvedValue([] as never)
  prismaMock.venueFeature.updateMany.mockReset().mockResolvedValue({ count: 1 } as never)
  prismaMock.venueFeature.create.mockReset().mockResolvedValue({ id: 'vf-nueva' } as never)
})

describe('bitácora: el superadmin prende o apaga una función', () => {
  it('prender una función guarda quién, cuál y la fila de la función', async () => {
    await enableFeatureForVenue('cven1', 'MESAS_SIN_RED', 'sa-1')

    expect(asiento('FEATURE_ENABLED_BY_ADMIN')).toEqual({
      staffId: 'sa-1',
      venueId: 'cven1',
      action: 'FEATURE_ENABLED_BY_ADMIN',
      entity: 'VenueFeature',
      entityId: 'vf-mesas',
      data: { featureCode: 'MESAS_SIN_RED' },
    })
  })

  it('apagar una función guarda quién, cuál y la fila de la función', async () => {
    await disableFeatureForVenue('cven1', 'MESAS_SIN_RED', 'sa-1')

    expect(asiento('FEATURE_DISABLED_BY_ADMIN')).toEqual({
      staffId: 'sa-1',
      venueId: 'cven1',
      action: 'FEATURE_DISABLED_BY_ADMIN',
      entity: 'VenueFeature',
      entityId: 'vf-mesas',
      data: { featureCode: 'MESAS_SIN_RED' },
    })
  })

  it.each([
    ['prender', () => enableFeatureForVenue('cven1', 'MESAS_SIN_RED')],
    ['apagar', () => disableFeatureForVenue('cven1', 'MESAS_SIN_RED')],
  ])('%s sin actor: no truena y guarda staffId null, con la función', async (_n, run) => {
    await expect(run()).resolves.toBeUndefined()

    const p = (logAction as jest.Mock).mock.calls[0][0]
    expect(p.staffId).toBeNull()
    expect(p.data).toEqual({ featureCode: 'MESAS_SIN_RED' })
  })

  it('regresión: prender un PLAN por la ruta genérica sigue guardando quién y cuál', async () => {
    prismaMock.feature.findUnique.mockResolvedValue(PRO as never)

    await enableFeatureForVenue('cven1', 'PLAN_PRO', 'sa-1')

    expect(asiento('FEATURE_ENABLED_BY_ADMIN')).toMatchObject({ staffId: 'sa-1', data: { featureCode: 'PLAN_PRO' } })
  })

  it('la cortesía que apaga el otro tier también guarda quién y cuál', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { id: 'vf-pro', featureId: 'feature-pro', active: true, stripeSubscriptionId: null },
    ] as never)

    await assignCompPlan('cven1', 'PREMIUM', 'sa-1')

    expect(asiento('FEATURE_DISABLED_BY_ADMIN')).toEqual({
      staffId: 'sa-1',
      venueId: 'cven1',
      action: 'FEATURE_DISABLED_BY_ADMIN',
      entity: 'VenueFeature',
      entityId: 'vf-pro',
      data: { featureCode: 'PLAN_PRO' },
    })
  })
})

describe('controlador: apagar pasa quién lo hizo', () => {
  it('DELETE …/features/:featureCode/disable manda el usuario de la sesión al servicio', async () => {
    const spy = jest.spyOn(superadminService, 'disableFeatureForVenue').mockResolvedValue(undefined)
    const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn() }
    const req: any = { params: { venueId: 'cven1', featureCode: 'MESAS_SIN_RED' }, authContext: { userId: 'sa-1' } }

    await superadminController.disableFeatureForVenue(req, res, jest.fn())

    expect(spy).toHaveBeenCalledWith('cven1', 'MESAS_SIN_RED', 'sa-1')
    expect(res.status).toHaveBeenCalledWith(204)
    spy.mockRestore()
  })
})
