/**
 * Planes editables B2, Task 6 (b2-r3 #3): la prueba SIN tarjeta que Stripe ya canceló antes de cerrar el alta la cierra en
 * Gratis. `pruebaSinTarjetaTerminada` dice si la suscripción del intento es ésa (cancelada al terminar su prueba, sin tarjeta y
 * sin un peso cobrado); `cerrarAltaEnGratis` cierra el paso del plan con un CAS y después termina el alta.
 *
 * Stripe, la base (el `prismaMock` global), el cierre final y la bitácora simulados.
 */
const mockInvList = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ invoices: { list: mockInvList } })))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))
const mockTerminar = jest.fn()
jest.mock('@/services/onboarding/terminarAltaCobrada', () => ({
  __esModule: true,
  terminarAltaCobrada: (...a: unknown[]) => mockTerminar(...a),
}))

import type Stripe from 'stripe'
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { cerrarAltaEnGratis, pruebaSinTarjetaTerminada } from '@/services/onboarding/cerrarAltaEnGratis'

const ORG = 'org-1'
const FIN = Math.floor(new Date('2026-12-09T00:00:00Z').getTime() / 1000)

const sub = (o: Record<string, unknown> = {}) =>
  ({
    id: 'sub_prueba',
    status: 'canceled',
    trial_end: FIN,
    ended_at: FIN,
    metadata: { sinTarjeta: 'true', planOfferVersion: '2', planActivationKey: `plan-activation:${ORG}:1` },
    ...o,
  }) as unknown as Stripe.Subscription

const updates = () => (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.calls.map((c: unknown[]) => c[0] as any)
function planDelCierre(): any {
  const fusiones = (prismaMock.$executeRaw as jest.Mock).mock.calls.filter(
    (c: any[]) => Array.isArray(c[0]) && c[0].join('').includes('"v2SetupData"'),
  )
  const ultima = fusiones.at(-1)
  return ultima ? JSON.parse(ultima[1]).plan : undefined
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockImplementation(async (cb: unknown) => (cb as (tx: unknown) => unknown)(prismaMock))
  prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
  mockTerminar.mockReset().mockResolvedValue({ estado: 'TERMINADA', venue: { id: 'venue-1' } })
  mockInvList.mockReset().mockResolvedValue({ has_more: false, data: [{ id: 'in_0', status: 'paid', total: 0, amount_paid: 0 }] })
})

describe('cerrarAltaEnGratis', () => {
  it('CAS IN_PROGRESS → ACTIVE con plan FREE, pruebaSinTarjetaTerminada y subscriptionId, planStripeSubscriptionId null, luego terminarAltaCobrada; CAS perdido (o un lease vivo, desde el barrido) → no termina nada', async () => {
    const lease = new Date('2026-12-09T10:05:00Z')

    await expect(cerrarAltaEnGratis(ORG, 1, sub(), lease, { via: 'navegador', staffId: 'staff-1' })).resolves.toBe(true)

    expect(updates()).toEqual([
      {
        where: {
          organizationId: ORG,
          completedAt: null,
          planActivationStatus: 'IN_PROGRESS',
          planActivationAttempt: 1,
          planActivationLeaseUntil: lease,
        },
        data: { planActivationStatus: 'ACTIVE', planActivationLeaseUntil: null, planStripeSubscriptionId: null },
      },
    ])
    expect(planDelCierre()).toEqual({
      tier: 'FREE',
      pruebaSinTarjetaTerminada: true,
      subscriptionId: 'sub_prueba',
      offerVersion: 2,
      acceptedAt: expect.any(String),
    })
    expect(mockTerminar).toHaveBeenCalledWith(ORG, { via: 'navegador', staffId: 'staff-1' })
    expect(jest.mocked(logAction)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PLAN_TRIAL_ENDED_ONBOARDING',
        staffId: 'staff-1',
        organizationId: ORG,
        data: expect.objectContaining({ subscriptionId: 'sub_prueba', offerVersion: 2, via: 'navegador' }),
      }),
    )
    // El cierre en Gratis va ANTES de terminar el alta (`terminarAltaCobrada` sólo termina con el plan resuelto).
    const ordenDelCas = (prismaMock.onboardingProgress.updateMany as jest.Mock).mock.invocationCallOrder[0]
    expect(ordenDelCas).toBeLessThan(mockTerminar.mock.invocationCallOrder[0])

    // Desde el barrido (sin lease propio): el CAS exige el lease nulo o vencido.
    jest.clearAllMocks()
    prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 1 } as never)
    await cerrarAltaEnGratis(ORG, 1, sub(), null, { via: 'barrido' })
    const desdeElBarrido = updates()[0].where
    expect(desdeElBarrido).toMatchObject({
      organizationId: ORG,
      completedAt: null,
      planActivationStatus: 'IN_PROGRESS',
      planActivationAttempt: 1,
    })
    expect(desdeElBarrido.OR).toEqual([{ planActivationLeaseUntil: null }, { planActivationLeaseUntil: { lt: expect.any(Date) } }])
    expect(mockTerminar).toHaveBeenCalledWith(ORG, { via: 'barrido' })

    // CAS perdido (otra petición lo tomó, o un lease vivo desde el barrido): ni plan, ni bitácora, ni cierre.
    jest.clearAllMocks()
    prismaMock.onboardingProgress.updateMany.mockResolvedValue({ count: 0 } as never)
    await expect(cerrarAltaEnGratis(ORG, 1, sub(), null, { via: 'barrido' })).resolves.toBe(false)
    expect(planDelCierre()).toBeUndefined()
    expect(mockTerminar).not.toHaveBeenCalled()
    expect(jest.mocked(logAction)).not.toHaveBeenCalled()
  })

  it('si terminar el alta falla, el paso del plan ya quedó en Gratis y no lanza (lo retoma el barrido)', async () => {
    mockTerminar.mockRejectedValue(new Error('la base se cayó'))
    await expect(cerrarAltaEnGratis(ORG, 1, sub(), null, { via: 'barrido' })).resolves.toBe(true)
    expect(planDelCierre()).toMatchObject({ tier: 'FREE', pruebaSinTarjetaTerminada: true })
  })
})

describe('pruebaSinTarjetaTerminada', () => {
  it('canceled, sinTarjeta, ended_at ≥ trial_end y ninguna factura pagada mayor que $0 → true', async () => {
    await expect(pruebaSinTarjetaTerminada(sub())).resolves.toBe(true)
    expect(mockInvList).toHaveBeenCalledWith({ subscription: 'sub_prueba', status: 'paid', limit: 100 })
    await expect(pruebaSinTarjetaTerminada(sub({ ended_at: FIN + 60 }))).resolves.toBe(true)
  })

  it('sin leer Stripe: otro estado, sin la metadata sinTarjeta, o cancelada antes de su trial_end → false', async () => {
    await expect(pruebaSinTarjetaTerminada(sub({ status: 'trialing' }))).resolves.toBe(false)
    await expect(pruebaSinTarjetaTerminada(sub({ metadata: { planOfferVersion: '2' } }))).resolves.toBe(false)
    await expect(pruebaSinTarjetaTerminada(sub({ ended_at: FIN - 60 }))).resolves.toBe(false)
    await expect(pruebaSinTarjetaTerminada(sub({ ended_at: null }))).resolves.toBe(false)
    expect(mockInvList).not.toHaveBeenCalled()
  })

  it('una factura pagada mayor que $0 (por tarjeta o por saldo), o una historia con más páginas → false (no es definitiva)', async () => {
    mockInvList.mockResolvedValueOnce({ has_more: false, data: [{ id: 'in_1', status: 'paid', total: 92684, amount_paid: 92684 }] })
    await expect(pruebaSinTarjetaTerminada(sub())).resolves.toBe(false)
    mockInvList.mockResolvedValueOnce({ has_more: false, data: [{ id: 'in_1', status: 'paid', total: 92684, amount_paid: 0 }] })
    await expect(pruebaSinTarjetaTerminada(sub())).resolves.toBe(false)
    mockInvList.mockResolvedValueOnce({ has_more: true, data: [] })
    await expect(pruebaSinTarjetaTerminada(sub())).resolves.toBe(false)
  })
})
