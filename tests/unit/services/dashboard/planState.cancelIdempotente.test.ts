/**
 * Plan Básico · full-testing del 17-nov: un doble clic en «Terminar mi Pro al acabar el periodo» mandó dos
 * `POST /plan/downgrade` y salieron 2 PLAN_CANCEL_SCHEDULED, 2 correos y 2 códigos promocionales en Stripe.
 *
 * `/plan/cancel` y `/plan/downgrade` pasan por `cancelPlan`: si la suscripción YA está en `cancel_at_period_end`, se
 * contesta el estado actual sin volver a tocar Stripe, sin ActivityLog, sin correo y sin código. Dos peticiones a la vez
 * se ordenan con un candado por negocio (`pg_advisory_xact_lock`): la segunda lee lo que dejó la primera.
 */
import { prismaMock } from '../../../__helpers__/setup'
import * as stripeService from '@/services/stripe.service'
import { cancelPlan, reactivatePlan } from '@/services/dashboard/planState.service'
import { scheduleDowngradeToFree } from '@/services/dashboard/seatReconciliation.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import emailService from '@/services/email.service'

jest.mock('@/services/stripe.service')
jest.mock('@/services/email.service', () => ({ __esModule: true, default: { sendPlanCancellationEmail: jest.fn() } }))
jest.mock('@/services/access/planNotification.service', () => ({
  resolvePlanNotificationTarget: jest.fn().mockResolvedValue({ email: 'duena@negocio.mx', locale: 'es', venueName: 'Estética Luna' }),
}))
const mockStripe = stripeService as jest.Mocked<typeof stripeService>

const DAY = 86400000
const FIN = new Date(Date.now() + 10 * DAY)
const filaPro = {
  id: 'vf_1',
  active: true,
  endDate: null,
  suspendedAt: null,
  gracePeriodEndsAt: null,
  monthlyPrice: { toNumber: () => 999 },
  stripeSubscriptionId: 'sub_123',
  updatedAt: new Date(),
  feature: { code: 'PLAN_PRO', name: 'Plan Pro' },
}

/** La suscripción de Stripe como estado: `setSubscriptionCancelAtPeriodEnd` la cambia, tras un viaje de red. */
let cancelando = false
const sub = () => ({
  status: 'active',
  cancelAtPeriodEnd: cancelando,
  currentPeriodEnd: FIN,
  createdAt: new Date(Date.now() - 90 * DAY),
  hasActiveDiscount: false,
  pausedUntil: null,
  interval: 'month' as const,
  grossAmountCents: 115884,
  descuento: null,
})
const red = () => new Promise(resolve => setTimeout(resolve, 5))

/**
 * Postgres en miniatura: `pg_advisory_xact_lock` espera a que suelte la transacción que lo tiene, y se suelta al terminar
 * esa transacción. Sin esto el mock global corre las dos transacciones a la vez y no prueba nada.
 */
function conCandadosDePostgres() {
  const tomados = new Map<string, Promise<void>>()
  prismaMock.$transaction.mockImplementation(async (cuerpo: (tx: unknown) => Promise<unknown>) => {
    const soltar: Array<() => void> = []
    const tx = {
      ...prismaMock,
      $queryRaw: async (strings: TemplateStringsArray, ...valores: unknown[]) => {
        if (!strings.join('?').includes('pg_advisory_xact_lock')) return []
        const llave = String(valores[0])
        while (tomados.has(llave)) await tomados.get(llave)
        let libre: () => void = () => undefined
        tomados.set(
          llave,
          new Promise<void>(resolve => {
            libre = () => {
              tomados.delete(llave)
              resolve()
            }
          }),
        )
        soltar.push(libre)
        return [{ pg_advisory_xact_lock: '' }]
      },
      $executeRaw: async () => 0,
    }
    try {
      return await cuerpo(tx)
    } finally {
      soltar.forEach(fn => fn())
    }
  })
}

beforeEach(() => {
  cancelando = false
  prismaMock.venueFeature.findMany.mockResolvedValue([filaPro] as never)
  prismaMock.venue.findUnique.mockResolvedValue({
    id: 'v1',
    slug: 'luna',
    timezone: 'America/Mexico_City',
    stripeCustomerId: 'cus_1',
  } as never)
  prismaMock.venue.update.mockResolvedValue({} as never)
  prismaMock.staffVenue.findMany.mockResolvedValue([] as never)
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.count.mockResolvedValue(1)
  mockStripe.retrievePlanSubscription.mockImplementation(async () => {
    await red()
    return sub() as never
  })
  mockStripe.setSubscriptionCancelAtPeriodEnd.mockImplementation(async (_id: string, cancel: boolean) => {
    await red()
    cancelando = cancel
    return {} as never
  })
  mockStripe.createWinbackPromotionCode.mockResolvedValue({ code: 'REGRESA-1' } as never)
  ;(logAction as jest.Mock).mockClear()
  ;(emailService.sendPlanCancellationEmail as jest.Mock).mockClear()
  conCandadosDePostgres()
})

const cancelaciones = () => (logAction as jest.Mock).mock.calls.filter(([e]) => e.action === 'PLAN_CANCEL_SCHEDULED')

describe('«Terminar mi Pro» / «Cancelar plan» son idempotentes', () => {
  it('🔴 doble clic: dos `/plan/downgrade` a la vez → UN cambio en Stripe, UN ActivityLog, UN correo, UN código', async () => {
    const estados = await Promise.all([
      scheduleDowngradeToFree('v1', [], { purpose: 'BASIC_PLAN' }),
      scheduleDowngradeToFree('v1', [], { purpose: 'BASIC_PLAN' }),
    ])
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledTimes(1)
    expect(cancelaciones()).toHaveLength(1)
    expect(emailService.sendPlanCancellationEmail).toHaveBeenCalledTimes(1)
    expect(mockStripe.createWinbackPromotionCode).toHaveBeenCalledTimes(1)
    // Los dos contestan el estado actual: el plan termina al acabar el periodo.
    expect(estados.map(e => e.cancelAtPeriodEnd)).toEqual([true, true])
  })

  it('🔴 dos `/plan/cancel` a la vez → lo mismo', async () => {
    await Promise.all([cancelPlan('v1', {}), cancelPlan('v1', {})])
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledTimes(1)
    expect(cancelaciones()).toHaveLength(1)
    expect(emailService.sendPlanCancellationEmail).toHaveBeenCalledTimes(1)
  })

  it('ya terminaba al acabar el periodo → contesta el estado actual sin tocar Stripe, sin ActivityLog ni correo', async () => {
    cancelando = true
    const estado = await cancelPlan('v1', { purpose: 'BASIC_PLAN' })
    expect(estado.cancelAtPeriodEnd).toBe(true)
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).not.toHaveBeenCalled()
    expect(cancelaciones()).toHaveLength(0)
    expect(emailService.sendPlanCancellationEmail).not.toHaveBeenCalled()
    expect(mockStripe.createWinbackPromotionCode).not.toHaveBeenCalled()
  })

  it('regresión: la primera cancelación sí cambia Stripe, deja su ActivityLog y manda su correo', async () => {
    await cancelPlan('v1', { reason: 'TOO_EXPENSIVE' } as never)
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledTimes(1)
    expect(cancelaciones()).toHaveLength(1)
    expect(emailService.sendPlanCancellationEmail).toHaveBeenCalledTimes(1)
  })

  it('regresión: reactivar después de cancelar sigue quitando el `cancel_at_period_end`', async () => {
    await cancelPlan('v1', {})
    await reactivatePlan('v1')
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenLastCalledWith('sub_123', false)
    expect((logAction as jest.Mock).mock.calls.map(([e]) => e.action)).toEqual(['PLAN_CANCEL_SCHEDULED', 'PLAN_REACTIVATED'])
  })

  it('regresión: si Stripe no contesta la lectura previa, la cancelación sigue (como antes)', async () => {
    mockStripe.retrievePlanSubscription.mockRejectedValueOnce(new Error('stripe caído'))
    await cancelPlan('v1', {})
    expect(mockStripe.setSubscriptionCancelAtPeriodEnd).toHaveBeenCalledWith('sub_123', true)
  })
})
