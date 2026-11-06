/**
 * 🔴 EL HUECO QUE CIERRA ESTE JOB (Codex gpt-6-astra xhigh, 19-sep, pasada de los tres detalles).
 *
 * `fulfillPlanCheckout` guarda el vínculo sin conceder acceso cuando la suscripción todavía no
 * está vigente, y confía en que `invoice.payment_succeeded` / `customer.subscription.updated`
 * concedan cuando el pago prospere. Pero esos avisos pueden llegar ANTES de que el vínculo exista:
 * terminan sin encontrar registro, se marcan SUCCESS, y el cron de webhooks sólo recoge
 * FAILED/RETRYING. **El cliente pagó y se queda sin plan, para siempre.**
 *
 * Ningún parche dentro de los manejadores lo cierra: el problema es que dependen del ORDEN de los
 * avisos. Este barrido no depende del orden — mira el estado REAL en Stripe, que es la autoridad.
 */
const mockRetrieve = jest.fn()
jest.mock('stripe', () => jest.fn().mockImplementation(() => ({ subscriptions: { retrieve: mockRetrieve } })))
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { venueFeature: { findMany: jest.fn() } },
}))
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { PlanAccessReconciliationJob } from '@/jobs/plan-access-reconciliation.job'
import { logAction } from '@/services/dashboard/activity-log.service'

const fila = (over: Record<string, unknown> = {}) => ({
  id: 'vf1',
  venueId: 'v1',
  stripeSubscriptionId: 'sub_1',
  feature: { code: 'PLAN_PRO' },
  ...over,
})

let conceder: jest.Mock

const nuevoJob = () => new PlanAccessReconciliationJob({ cron: { start: jest.fn(), stop: jest.fn() }, conceder })

beforeEach(() => {
  jest.clearAllMocks()
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
  conceder = jest.fn().mockResolvedValue(true)
  ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([])
})

describe('plan-access-reconciliation', () => {
  it('🔴 concede el acceso a quien pagó y se quedó sin plan', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([fila()])
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' })

    const r = await nuevoJob().runNow()

    expect(conceder).toHaveBeenCalledTimes(1)
    expect(conceder.mock.calls[0][0]).toMatchObject({ id: 'sub_1', status: 'active' })
    expect(r.recuperados).toBe(1)
  })

  it('🔴 V5-A paso 6: si el manejador NO concedió (la suscripción ya vende otro plan y decide la entrega), no cuenta ni audita una recuperación', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([fila()])
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' })
    conceder.mockResolvedValue(false)

    const r = await nuevoJob().runNow()

    expect(conceder).toHaveBeenCalledTimes(1)
    expect(r.recuperados).toBe(0)
    expect(logAction).not.toHaveBeenCalled()
  })

  it('un trial vigente también cuenta', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([fila()])
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'trialing' })

    expect((await nuevoJob().runNow()).recuperados).toBe(1)
  })

  it('🔴 NO concede si la suscripción sigue sin estar vigente (no inventa accesos)', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([fila()])
    for (const estado of ['canceled', 'unpaid', 'past_due', 'incomplete', 'incomplete_expired', 'paused']) {
      jest.clearAllMocks()
      conceder = jest.fn()
      ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([fila()])
      mockRetrieve.mockResolvedValue({ id: 'sub_1', status: estado })

      const r = await nuevoJob().runNow()

      expect(conceder).not.toHaveBeenCalled()
      expect(r.recuperados).toBe(0)
    }
  })

  it('🔴 mira sólo filas LIGADAS a Stripe que no dan acceso: planes apagados, suspendidas y vencidas por fecha (D4)', async () => {
    await nuevoJob().runNow()

    const where = (prisma.venueFeature.findMany as jest.Mock).mock.calls[0][0].where
    expect(where.stripeSubscriptionId).toEqual({ not: null })
    const [apagadas, suspendidas, vencidas] = where.OR
    // Como siempre: planes base apagados sin suspensión.
    expect(apagadas).toMatchObject({ active: false, suspendedAt: null })
    expect(apagadas.feature.code.in).toEqual(expect.arrayContaining(['PLAN_PRO', 'PLAN_PREMIUM']))
    // codex r1 #4: una suspendida que YA pagó y cuyos avisos se perdieron. La suspensión sólo la levanta Stripe `active`
    // (handleSubscriptionUpdated lo exige): el barrido observa el pago, no lo perdona.
    expect(suspendidas).toEqual({ suspendedAt: { not: null } })
    // 🔴 D4: activa, sin suspender, con la prueba vencida y sin gracia vigente — la regla única la niega.
    expect(vencidas).toMatchObject({ active: true, suspendedAt: null, endDate: { lt: expect.any(Date) } })
    expect(vencidas.OR).toEqual([{ gracePeriodEndsAt: null }, { gracePeriodEndsAt: { lt: expect.any(Date) } }])
  })

  it('🔴 D4: una prueba vencida cuyo cobro Stripe ya hizo (avisos perdidos) se repara y se audita', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([fila({ feature: { code: 'INVENTORY_TRACKING' } })])
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' })

    const r = await nuevoJob().runNow()

    expect(r.recuperados).toBe(1)
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PLAN_ACCESS_RECONCILED' }))
  })

  it('🔴 la consulta está ACOTADA y con orden estable (regla de queries del repo)', async () => {
    await nuevoJob().runNow()

    const args = (prisma.venueFeature.findMany as jest.Mock).mock.calls[0][0]
    expect(args.take).toBeLessThanOrEqual(25)
    expect(args.orderBy).toEqual({ id: 'asc' })
  })

  it('🔴 el cursor ROTA: la segunda corrida no vuelve a mirar los mismos', async () => {
    const job = nuevoJob()
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([fila({ id: 'vf9' })])
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled' })

    await job.runNow()
    await job.runNow()

    // Sin rotación, un conjunto grande de cancelados taparía para siempre a quien sí pagó.
    expect((prisma.venueFeature.findMany as jest.Mock).mock.calls[1][0].cursor).toEqual({ id: 'vf9' })
  })

  it('🔴 vuelve al principio cuando se acaba la lista (si no, deja de barrer)', async () => {
    const job = nuevoJob()
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValueOnce([fila({ id: 'vf9' })]).mockResolvedValueOnce([])
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'canceled' })

    await job.runNow()
    await job.runNow()
    await job.runNow()

    expect((prisma.venueFeature.findMany as jest.Mock).mock.calls[2][0].cursor).toBeUndefined()
  })

  it('🔴 un fallo con una fila no detiene el barrido de las demás', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([
      fila({ id: 'a', stripeSubscriptionId: 'sub_a' }),
      fila({ id: 'b', stripeSubscriptionId: 'sub_b' }),
    ])
    mockRetrieve.mockRejectedValueOnce(new Error('Stripe caído')).mockResolvedValueOnce({ id: 'sub_b', status: 'active' })

    const r = await nuevoJob().runNow()

    expect(r.recuperados).toBe(1)
    expect(r.fallidos).toBe(1)
  })

  it('deja rastro en ActivityLog de cada acceso recuperado', async () => {
    ;(prisma.venueFeature.findMany as jest.Mock).mockResolvedValue([fila()])
    mockRetrieve.mockResolvedValue({ id: 'sub_1', status: 'active' })

    await nuevoJob().runNow()

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'PLAN_ACCESS_RECONCILED', venueId: 'v1' }))
  })
})
