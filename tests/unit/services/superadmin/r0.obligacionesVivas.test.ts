/**
 * R0 del rediseño de la compra (Codex, 21-sep-2026, rondas v1 y v2): escritores que borraban o apagaban
 * el vínculo a una suscripción que SEGUÍA COBRANDO. El negocio pagaba sin acceso, o la suscripción
 * quedaba sin representación local (y los webhooks, sin fila que encontrar).
 *
 * Regla que pidió Codex para entregarlo antes del rediseño: RECHAZAR (409), nunca «conservar el vínculo
 * y conceder igual», nunca cancelar por debajo.
 */
import AppError from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service' // mockeado globalmente en setup
import { prismaMock } from '../../../__helpers__/setup'

const mockExigir = jest.fn()
const mockBorrarCarpeta = jest.fn()
jest.mock('@/services/storage.service', () => ({
  ...jest.requireActual('@/services/storage.service'),
  deleteVenueFolder: (...a: unknown[]) => mockBorrarCarpeta(...a),
}))
jest.mock('@/services/stripe.service', () => ({
  ...jest.requireActual('@/services/stripe.service'),
  exigirSinObligacionViva: (...a: unknown[]) => mockExigir(...a),
}))
jest.mock('stripe')

import { adjustVenuePlanEndDate, deactivateVenuePlan, grantVenuePlanTrial } from '@/services/superadmin/subscription.service'
import { assignCompPlan, disableFeatureForVenue, enableFeatureForVenue, grantTrialForVenue } from '@/services/dashboard/superadmin.service'
import { deleteVenue } from '@/services/dashboard/venue.dashboard.service'

const viva = () =>
  new AppError('No se puede: el negocio tiene una suscripción en Stripe que sigue cobrando', 409, true, 'LIVE_SUBSCRIPTION_LINKED')

beforeEach(() => {
  mockExigir.mockReset().mockResolvedValue(undefined)
  mockBorrarCarpeta.mockReset().mockResolvedValue(undefined)
  prismaMock.$queryRaw.mockReset().mockResolvedValue([{ stripeCustomerId: null }] as never)
  prismaMock.$transaction.mockImplementation(async (cb: (tx: never) => Promise<unknown>) => cb(prismaMock as never))
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'cven1' } as never)
  prismaMock.feature.findUnique.mockResolvedValue({ id: 'feature-pro', code: 'PLAN_PRO', monthlyPrice: 1158.84 } as never)
  prismaMock.feature.findMany.mockResolvedValue([PRO, PREMIUM] as never)
})

const PRO = { id: 'feature-pro', code: 'PLAN_PRO', monthlyPrice: 1158.84 }
const PREMIUM = { id: 'feature-premium', code: 'PLAN_PREMIUM', monthlyPrice: 2318.84 }

describe('superadmin · plan (subscription.service)', () => {
  const conVinculo = (id: string | null) =>
    prismaMock.venueFeature.findFirst.mockResolvedValue({ id: 'vf1', endDate: null, stripeSubscriptionId: id } as never)

  it.each([
    ['conceder una prueba', () => grantVenuePlanTrial('cven1', 14, 'staff-1')],
    ['desactivar el plan', () => deactivateVenuePlan('cven1', 'staff-1')],
    ['ajustar la vigencia', () => adjustVenuePlanEndDate('cven1', 5, 'staff-1')],
  ])('🔴 %s con una suscripción que cobra: 409 y NO escribe', async (_n, run) => {
    conVinculo('sub_viva')
    mockExigir.mockRejectedValue(viva())

    await expect(run()).rejects.toMatchObject({ statusCode: 409, code: 'LIVE_SUBSCRIPTION_LINKED' })

    expect(mockExigir).toHaveBeenCalledWith('sub_viva', expect.any(String))
    expect(prismaMock.venueFeature.upsert).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.update).not.toHaveBeenCalled()
  })

  it.each([
    ['conceder una prueba', () => grantVenuePlanTrial('cven1', 14, 'staff-1')],
    ['desactivar el plan', () => deactivateVenuePlan('cven1', 'staff-1')],
    ['ajustar la vigencia', () => adjustVenuePlanEndDate('cven1', 5, 'staff-1')],
  ])('🔴 %s: la escritura es CONDICIONAL al vínculo comprobado (una suscripción ligada después de leer no se pisa)', async (_n, run) => {
    conVinculo(null)
    // El UPDATE condicional no encuentra la fila con el vínculo esperado: alguien ligó una suscripción después de la última lectura.
    prismaMock.venueFeature.updateMany.mockResolvedValue({ count: 0 } as never)

    await expect(run()).rejects.toMatchObject({ statusCode: 409, code: 'SUBSCRIPTION_LINK_CHANGED' })
    expect(prismaMock.venueFeature.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ stripeSubscriptionId: null }) }),
    )
    expect(prismaMock.venueFeature.upsert).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.update).not.toHaveBeenCalled()
  })

  it('conceder una prueba donde no hay fila la CREA (nunca upsert que pisaría una recién creada)', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(null as never)
    prismaMock.venueFeature.updateMany.mockResolvedValue({ count: 0 } as never)
    prismaMock.venueFeature.create.mockResolvedValue({ id: 'vf-nueva' } as never)
    prismaMock.venue.findFirst.mockResolvedValue(null as never)

    await grantVenuePlanTrial('cven1', 14, 'staff-1').catch(() => undefined)

    expect(prismaMock.venueFeature.create).toHaveBeenCalled()
    expect(prismaMock.venueFeature.upsert).not.toHaveBeenCalled()
  })
})

describe('superadmin · funciones (dashboard/superadmin.service)', () => {
  it('🔴 conceder un trial local sobre una suscripción que cobra: 409 (no un «Failed» genérico)', async () => {
    prismaMock.venueFeature.findUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_viva' } as never)
    mockExigir.mockRejectedValue(viva())

    await expect(grantTrialForVenue('cven1', 'LOYALTY_PROGRAM', 14)).rejects.toMatchObject({ code: 'LIVE_SUBSCRIPTION_LINKED' })
    expect(prismaMock.venueFeature.upsert).not.toHaveBeenCalled()
  })

  it('🔴 trial local sobre un vínculo muerto: escribe CONDICIONAL a ese vínculo y limpia la cobranza', async () => {
    prismaMock.venueFeature.findUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_cancelada' } as never)
    prismaMock.venueFeature.updateMany.mockResolvedValue({ count: 0 } as never) // alguien ligó otra suscripción después de leer

    await expect(grantTrialForVenue('cven1', 'LOYALTY_PROGRAM', 14)).rejects.toMatchObject({ code: 'SUBSCRIPTION_LINK_CHANGED' })
    expect(prismaMock.venueFeature.updateMany).toHaveBeenCalledWith({
      where: { id: 'vf1', stripeSubscriptionId: 'sub_cancelada' },
      data: expect.objectContaining({ stripeSubscriptionId: null, suspendedAt: null, paymentFailureCount: 0 }),
    })
  })

  it('trial local sin fila: si otra escritura la creó antes (P2002) es 409, no un 500 genérico', async () => {
    prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
    prismaMock.venueFeature.create.mockRejectedValue({ code: 'P2002' })

    await expect(grantTrialForVenue('cven1', 'LOYALTY_PROGRAM', 14)).rejects.toMatchObject({ code: 'SUBSCRIPTION_LINK_CHANGED' })
  })

  it('🔴 desactivar una función que cobra: 409 y NO la apaga', async () => {
    prismaMock.venueFeature.findUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: 'sub_viva' } as never)
    mockExigir.mockRejectedValue(viva())

    await expect(disableFeatureForVenue('cven1', 'LOYALTY_PROGRAM')).rejects.toMatchObject({ code: 'LIVE_SUBSCRIPTION_LINKED' })
    expect(prismaMock.venueFeature.update).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 cortesía PREMIUM sobre un PREMIUM que sigue cobrando: 409 (no declara «gratis» lo que Stripe cobra)', async () => {
    // Ninguna fila activa del otro tier: antes se saltaba la validación y se «regalaba» el destino.
    prismaMock.venueFeature.findFirst.mockResolvedValue(null as never)
    prismaMock.venueFeature.findMany.mockResolvedValue([{ stripeSubscriptionId: 'sub_premium_viva' }] as never)
    mockExigir.mockRejectedValue(viva())

    await expect(assignCompPlan('cven1', 'PREMIUM')).rejects.toMatchObject({ code: 'LIVE_SUBSCRIPTION_LINKED' })
    expect(mockExigir).toHaveBeenCalledWith('sub_premium_viva', expect.any(String))
    expect(prismaMock.venueFeature.upsert).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 pasar a cortesía FREE con un plan que cobra: 409 (no le quita el plan a quien paga)', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { id: 'vf1', featureId: 'feature-pro', active: true, stripeSubscriptionId: 'sub_viva' },
    ] as never)
    mockExigir.mockRejectedValue(viva())

    await expect(assignCompPlan('cven1', 'FREE')).rejects.toMatchObject({ code: 'LIVE_SUBSCRIPTION_LINKED' })
    expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('desactivar una función sin suscripción viva sí la apaga, condicionado al vínculo leído', async () => {
    prismaMock.venueFeature.findUnique.mockResolvedValue({ id: 'vf1', stripeSubscriptionId: null } as never)
    prismaMock.venueFeature.updateMany.mockResolvedValue({ count: 1 } as never)

    await disableFeatureForVenue('cven1', 'LOYALTY_PROGRAM')

    expect(prismaMock.venueFeature.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'vf1', stripeSubscriptionId: null }, data: expect.objectContaining({ active: false }) }),
    )
  })
})

describe('cortesía del plan (R0 ronda 3, Codex)', () => {
  // Una transacción con su propio `tx`: lo que no pase por aquí, no está dentro de la transacción.
  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    venueFeature: { findMany: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
  }
  const acciones = () => (logAction as jest.Mock).mock.calls.map((c: any[]) => c[0].action)
  /** La lectura validada y la relectura bajo el candado ven lo mismo (nadie tocó el plan en medio). */
  const filasLeidas = (filas: unknown[]) => {
    prismaMock.venueFeature.findMany.mockResolvedValue(filas as never)
    tx.venueFeature.findMany.mockResolvedValue(filas)
  }

  beforeEach(() => {
    tx.$queryRaw.mockReset().mockResolvedValue([{ id: 'cven1' }])
    tx.venueFeature.findMany.mockReset().mockResolvedValue([])
    tx.venueFeature.updateMany.mockReset().mockResolvedValue({ count: 1 })
    tx.venueFeature.create.mockReset().mockResolvedValue({ id: 'vf-nueva' })
    prismaMock.$transaction.mockImplementation(async (cb: (t: never) => Promise<unknown>) => cb(tx as never))
    prismaMock.venueFeature.updateMany.mockReset()
  })

  it('🔴 escribe contra el vínculo COMPROBADO, no contra una relectura posterior', async () => {
    filasLeidas([{ id: 'vf-premium', featureId: 'feature-premium', active: false, stripeSubscriptionId: 'sub_muerta' }])
    // Una relectura después de validar vería otro vínculo: la escritura NO debe usarla.
    prismaMock.venueFeature.findUnique.mockResolvedValue({ id: 'vf-premium', stripeSubscriptionId: 'sub_recien_ligada' } as never)

    await assignCompPlan('cven1', 'PREMIUM').catch(() => undefined)

    expect(mockExigir).toHaveBeenCalledWith('sub_muerta', expect.any(String))
    expect(tx.venueFeature.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'vf-premium', stripeSubscriptionId: 'sub_muerta' } }),
    )
  })

  it('🔴 apagar el otro tier y activar el destino van en UNA transacción; si el destino choca, no se audita nada', async () => {
    filasLeidas([
      { id: 'vf-pro', featureId: 'feature-pro', active: true, stripeSubscriptionId: null },
      { id: 'vf-premium', featureId: 'feature-premium', active: false, stripeSubscriptionId: null },
    ])
    tx.venueFeature.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 })

    await expect(assignCompPlan('cven1', 'PREMIUM')).rejects.toMatchObject({ code: 'SUBSCRIPTION_LINK_CHANGED' })

    expect(tx.venueFeature.updateMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled() // nada fuera de la transacción
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 el destino queda sin el vínculo muerto ni banderas de cobranza', async () => {
    filasLeidas([{ id: 'vf-pro', featureId: 'feature-pro', active: false, stripeSubscriptionId: 'sub_cancelada' }])

    await assignCompPlan('cven1', 'PRO').catch(() => undefined)

    expect(tx.venueFeature.updateMany).toHaveBeenCalledWith({
      where: { id: 'vf-pro', stripeSubscriptionId: 'sub_cancelada' },
      data: expect.objectContaining({
        active: true,
        endDate: null,
        stripeSubscriptionId: null,
        stripeSubscriptionItemId: null,
        suspendedAt: null,
        gracePeriodEndsAt: null,
        paymentFailureCount: 0,
      }),
    })
  })

  it('sin fila del destino la CREA dentro de la transacción; si otra la creó antes (P2002) es 409', async () => {
    filasLeidas([])
    tx.venueFeature.create.mockRejectedValue({ code: 'P2002' })

    await expect(assignCompPlan('cven1', 'PRO')).rejects.toMatchObject({ code: 'SUBSCRIPTION_LINK_CHANGED' })
    expect(prismaMock.venueFeature.create).not.toHaveBeenCalled()
  })

  it('FREE apaga los tiers activos contra su vínculo; audita DESPUÉS de confirmar', async () => {
    filasLeidas([
      { id: 'vf-pro', featureId: 'feature-pro', active: true, stripeSubscriptionId: 'sub_cancelada' },
      { id: 'vf-premium', featureId: 'feature-premium', active: false, stripeSubscriptionId: null },
    ])

    await assignCompPlan('cven1', 'FREE').catch(() => undefined)

    expect(tx.venueFeature.updateMany).toHaveBeenCalledTimes(1) // la inactiva no se toca
    expect(tx.venueFeature.updateMany).toHaveBeenCalledWith({
      where: { id: 'vf-pro', stripeSubscriptionId: 'sub_cancelada', active: true },
      data: expect.objectContaining({ active: false, endDate: expect.any(Date) }),
    })
    expect(acciones()).toEqual(expect.arrayContaining(['FEATURE_DISABLED_BY_ADMIN', 'PLAN_COMP_ASSIGNED']))
  })

  it('🔴 dos cortesías simultáneas: la segunda relee BAJO el candado del negocio y, si el plan cambió, 409 sin tocar nada', async () => {
    // Las dos peticiones leyeron «no hay filas». La primera confirmó PRO; la segunda, al tomar el candado, lo ve.
    prismaMock.venueFeature.findMany.mockResolvedValue([] as never)
    tx.venueFeature.findMany.mockResolvedValue([{ id: 'vf-pro', featureId: 'feature-pro', active: true, stripeSubscriptionId: null }])

    await expect(assignCompPlan('cven1', 'PREMIUM')).rejects.toMatchObject({ code: 'SUBSCRIPTION_LINK_CHANGED' })

    expect(tx.venueFeature.create).not.toHaveBeenCalled()
    expect(tx.venueFeature.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 una fila que estaba inactiva y se ACTIVÓ en medio también cuenta como cambio', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { id: 'vf-pro', featureId: 'feature-pro', active: false, stripeSubscriptionId: null },
    ] as never)
    tx.venueFeature.findMany.mockResolvedValue([{ id: 'vf-pro', featureId: 'feature-pro', active: true, stripeSubscriptionId: null }])

    await expect(assignCompPlan('cven1', 'PREMIUM')).rejects.toMatchObject({ code: 'SUBSCRIPTION_LINK_CHANGED' })
    expect(tx.venueFeature.create).not.toHaveBeenCalled()
  })

  it('🔴 Codex C2: toma el MISMO candado del negocio que la entrega (y luego la fila), ANTES de releer', async () => {
    filasLeidas([])

    await assignCompPlan('cven1', 'PRO').catch(() => undefined)

    const sqls = tx.$queryRaw.mock.calls.map(c => (c[0] as string[]).join('?'))
    expect(sqls[0]).toMatch(/pg_advisory_xact_lock/)
    expect(tx.$queryRaw.mock.calls[0].slice(1)).toContain('stripe-obligaciones:cven1')
    expect(sqls.some(q => /FROM "Venue"/.test(q) && /FOR UPDATE/.test(q))).toBe(true)
    // Toda relectura (la del final de la transacción) va después del candado.
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.venueFeature.findMany.mock.invocationCallOrder[tx.venueFeature.findMany.mock.invocationCallOrder.length - 1],
    )
  })
})

describe('borrar un venue', () => {
  it('🔴 un venue TRIAL con una suscripción que cobra no se borra', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({ id: 'cven1', name: 'Cafe', slug: 'cafe', status: 'TRIAL' } as never)
    prismaMock.venueFeature.findMany.mockResolvedValue([{ stripeSubscriptionId: 'sub_viva' }] as never)
    mockExigir.mockRejectedValue(viva())

    await expect(deleteVenue('org-1', 'cven1')).rejects.toMatchObject({ code: 'LIVE_SUBSCRIPTION_LINKED' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 un venue con cliente de Stripe NO se borra: 409 y no toca ni Storage ni la base (se cierra, no se borra)', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({
      id: 'cven1',
      name: 'Cafe',
      slug: 'cafe',
      status: 'TRIAL',
      stripeCustomerId: 'cus_1',
    } as never)
    prismaMock.venueFeature.findMany.mockResolvedValue([] as never)

    await expect(deleteVenue('org-1', 'cven1')).rejects.toMatchObject({ statusCode: 409, code: 'VENUE_HAS_BILLING_CUSTOMER' })
    expect(mockBorrarCarpeta).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 dentro de la transacción se re-comprueba con la fila BLOQUEADA: un cliente creado después aborta — y Storage sigue intacto', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({
      id: 'cven1',
      name: 'Cafe',
      slug: 'cafe',
      status: 'TRIAL',
      stripeCustomerId: null,
    } as never)
    prismaMock.venueFeature.findMany.mockResolvedValue([] as never)
    prismaMock.$queryRaw.mockResolvedValue([{ stripeCustomerId: 'cus_tarde' }] as never)

    await expect(deleteVenue('org-1', 'cven1')).rejects.toMatchObject({ statusCode: 409, code: 'VENUE_HAS_BILLING_CUSTOMER' })
    const sql = (prismaMock.$queryRaw.mock.calls[0][0] as string[]).join('?')
    expect(sql).toMatch(/FOR UPDATE/)
    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(mockBorrarCarpeta).not.toHaveBeenCalled()
    expect((logAction as jest.Mock).mock.calls.map((c: any[]) => c[0].action)).not.toContain('VENUE_DELETED')
  })
})

describe('🔴 Codex C2: la ruta genérica de funciones no enciende PLANES a ciegas', () => {
  it('un código de plan pasa por la cortesía (revisa Stripe y el otro tier) y nunca hace upsert', async () => {
    prismaMock.venue.findUnique.mockResolvedValue({ id: 'cven1' } as never)
    prismaMock.feature.findUnique.mockResolvedValue({ id: 'feat-premium', code: 'PLAN_PREMIUM', monthlyPrice: 1999 } as never)
    prismaMock.feature.findMany.mockResolvedValue([
      { id: 'feat-premium', code: 'PLAN_PREMIUM', monthlyPrice: 1999 },
      { id: 'feat-pro', code: 'PLAN_PRO', monthlyPrice: 999 },
    ] as never)
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { id: 'vf-pro', featureId: 'feat-pro', active: true, stripeSubscriptionId: 'sub_viva' },
    ] as never)
    mockExigir.mockRejectedValueOnce(viva())

    await expect(enableFeatureForVenue('cven1', 'PLAN_PREMIUM')).rejects.toMatchObject({ code: 'LIVE_SUBSCRIPTION_LINKED' })
    expect(mockExigir).toHaveBeenCalledWith('sub_viva', expect.any(String))
    expect(prismaMock.venueFeature.upsert).not.toHaveBeenCalled()
  })
})

/**
 * 🔴 Codex R2 (ronda 2): `grantTrialForVenue` es genérica —sirve para cualquier función— pero acepta también `PLAN_PRO`
 * y `PLAN_PREMIUM`, y escribía su fila sin candado y sin mirar el OTRO tier. `extendPlanTrial` la usa. Conceder una
 * prueba PRO a quien tenía PREMIUM activo dejaba los DOS planes vivos, en secuencia, sin ninguna carrera.
 */
describe('🔴 R2: la prueba genérica tampoco puede dejar dos planes vivos', () => {
  beforeEach(() => {
    prismaMock.feature.findUnique.mockResolvedValue({ id: 'feature-pro', code: 'PLAN_PRO', monthlyPrice: 1158.84 } as never)
    prismaMock.venueFeature.findUnique.mockResolvedValue(null as never)
    prismaMock.venueFeature.findMany.mockReset().mockResolvedValue([] as never)
    prismaMock.venueFeature.create.mockReset().mockResolvedValue({ id: 'vf-nueva' } as never)
    prismaMock.venueFeature.updateMany.mockReset().mockResolvedValue({ count: 1 } as never)
  })

  it('🔴 con el otro tier ACTIVO: 409 y nada escrito', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { featureId: 'feature-premium', active: true, stripeSubscriptionId: null },
    ] as never)

    await expect(grantTrialForVenue('cven1', 'PLAN_PRO', 14)).rejects.toMatchObject({ statusCode: 409, code: 'OTRO_PLAN_ACTIVO' })
    expect(prismaMock.venueFeature.create).not.toHaveBeenCalled()
    expect(prismaMock.venueFeature.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 con el otro tier LIGADO a Stripe aunque apagado (sigue cobrando): 409', async () => {
    prismaMock.venueFeature.findMany.mockResolvedValue([
      { featureId: 'feature-premium', active: false, stripeSubscriptionId: 'sub_premium' },
    ] as never)

    await expect(grantTrialForVenue('cven1', 'PLAN_PRO', 14)).rejects.toMatchObject({ statusCode: 409, code: 'OTRO_PLAN_ACTIVO' })
    expect(prismaMock.venueFeature.create).not.toHaveBeenCalled()
  })

  it('el plan concedido bajo el candado del negocio: sin otro tier, se concede', async () => {
    await grantTrialForVenue('cven1', 'PLAN_PRO', 14)

    expect(prismaMock.venueFeature.create).toHaveBeenCalled()
    // El MISMO candado que la entrega y la regla común.
    const candado = (prismaMock.$queryRaw as jest.Mock).mock.calls.find((c: unknown[]) => JSON.stringify(c).includes('stripe-obligaciones'))
    expect(candado).toBeDefined()
  })

  it('una función que NO es plan no paga el candado ni la lectura de tiers', async () => {
    prismaMock.feature.findUnique.mockResolvedValue({ id: 'f-loyal', code: 'LOYALTY_PROGRAM', monthlyPrice: 99 } as never)

    await grantTrialForVenue('cven1', 'LOYALTY_PROGRAM', 14)

    expect(prismaMock.venueFeature.findMany).not.toHaveBeenCalled()
  })
})
